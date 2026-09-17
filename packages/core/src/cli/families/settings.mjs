// `contextcake settings` (control-plane spec §5.5, settings half). A shim
// over control/settings.mjs and the catalog in settings.mjs, the same
// operations GET/PATCH /api/settings run. Settings are manifest-wide, not per
// profile, and resolve manifest > environment > default.
//
// Credentials are not settings; they arrive with milestone 5. Until then a
// headless GitHub source names a variable with `source add --token-env`.

import { ControlError, manifestControlError } from "../../control/errors.mjs";
import { patchSettings, settingsView } from "../../control/settings.mjs";
import { readContextManifestQuarantined } from "../../manifest.mjs";
import { SETTING_DEFS, SETTING_KEYS, resolveSettings } from "../../settings.mjs";
import { defineFamily } from "../table.mjs";

const VIEW = {
  type: "object",
  required: ["settings", "stored", "origins", "catalog"],
  properties: {
    settings: { type: "object", description: "Effective value per key." },
    stored: { type: "object", description: "What the manifest holds." },
    origins: { type: "object", description: "manifest, env, or default, per key." },
    catalog: {
      type: "array",
      items: { type: "object", required: ["key", "label", "help", "min", "max", "default", "env"] },
    },
  },
};

const SETTING = {
  type: "object",
  required: ["key", "value", "origin", "default", "min", "max", "env"],
  properties: {
    key: { enum: SETTING_KEYS },
    value: { type: "integer" },
    origin: { enum: ["manifest", "env", "default"] },
    stored: { type: ["integer", "null"] },
    default: { type: "integer" },
    min: { type: "integer" },
    max: { type: "integer" },
    env: { type: "string" },
    label: { type: "string" },
  },
};

function view(ctx) {
  // A settings read tolerates an invalid source, as GET /api/settings does.
  const manifest = ctx.readManifest({ tolerant: true });
  return settingsView({ manifest, settings: resolveSettings(manifest) });
}

function requireKey(key) {
  if (!Object.hasOwn(SETTING_DEFS, key)) {
    throw new ControlError("SETTINGS_INVALID", `Unknown setting: ${key}. Known settings: ${SETTING_KEYS.join(", ")}.`, { status: 400 });
  }
}

function setting(data, key) {
  const def = data.catalog.find((entry) => entry.key === key);
  return {
    key,
    value: data.settings[key],
    origin: data.origins[key],
    stored: data.stored[key] ?? null,
    default: def.default,
    min: def.min,
    max: def.max,
    env: def.env,
    label: def.label,
  };
}

function settingLine(entry) {
  return `${entry.key}\t${entry.value}\t(${entry.origin})`;
}

// The write. Callers answer with freshView, so the envelope shows what the
// engine will now use.
function patch(ctx, body) {
  ctx.readManifest({ tolerant: true });
  try {
    patchSettings(ctx.manifestPath, body, { expectRevision: ctx.flags.expectRevision });
  } catch (error) {
    throw manifestControlError(error);
  }
}

// ctx.readManifest caches the copy from before the write, so read again.
function freshView(ctx) {
  const current = readContextManifestQuarantined(ctx.manifestPath, { allowMissing: false }).manifest;
  return settingsView({ manifest: current, settings: resolveSettings(current) });
}

export default defineFamily({
  name: "settings",
  stability: "experimental",
  summary: "read and change engine settings (manifest > environment > default)",
  commands: [
    {
      name: "list",
      summary: "every setting with its effective value and where it came from",
      mutation: "read",
      manifest: "required",
      output: VIEW,
      run(ctx) {
        const data = view(ctx);
        return { data, text: SETTING_KEYS.map((key) => settingLine(setting(data, key))).join("\n") };
      },
    },
    {
      name: "get",
      summary: "one setting's effective value, origin, range, and environment variable",
      mutation: "read",
      manifest: "required",
      positionals: [{ name: "key", required: true, description: `One of ${SETTING_KEYS.join(", ")}.` }],
      errors: ["SETTINGS_INVALID"],
      output: SETTING,
      run(ctx) {
        requireKey(ctx.args.key);
        const data = setting(view(ctx), ctx.args.key);
        return { data, text: `${data.value} (${data.origin}; default ${data.default}, range ${data.min}-${data.max}, env ${data.env})` };
      },
    },
    {
      name: "set",
      summary: "store a setting in the manifest; it then wins over the environment",
      mutation: "write",
      manifest: "required",
      preconditions: ["manifest-revision"],
      positionals: [
        { name: "key", required: true, description: `One of ${SETTING_KEYS.join(", ")}.` },
        { name: "value", required: true, description: "A number inside the setting's range." },
      ],
      errors: ["SETTINGS_INVALID"],
      output: SETTING,
      run(ctx) {
        requireKey(ctx.args.key);
        patch(ctx, { [ctx.args.key]: ctx.args.value });
        const data = setting(freshView(ctx), ctx.args.key);
        return { data, text: `${data.key} = ${data.value}` };
      },
    },
    {
      name: "reset",
      summary: "remove stored settings so the environment or default applies",
      mutation: "write",
      manifest: "required",
      preconditions: ["manifest-revision"],
      positionals: [{ name: "keys", variadic: true, description: "Settings to reset." }],
      flags: { all: { type: "boolean", description: "Reset every setting." } },
      errors: ["SETTINGS_INVALID"],
      output: VIEW,
      run(ctx) {
        const keys = ctx.flags.all ? SETTING_KEYS : (ctx.args.keys ?? []);
        if (ctx.flags.all && ctx.args.keys?.length) throw new ControlError("INVALID_INPUT", "Pass setting names or --all, not both.", { status: 400 });
        if (!keys.length) throw new ControlError("INVALID_INPUT", "Name the settings to reset, or pass --all.", { status: 400 });
        for (const key of keys) requireKey(key);
        patch(ctx, Object.fromEntries(keys.map((key) => [key, null])));
        const data = freshView(ctx);
        return { data, text: keys.map((key) => settingLine(setting(data, key))).join("\n") };
      },
    },
  ],
});
