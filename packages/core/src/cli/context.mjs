// The object every table command's run(ctx) receives. It owns the shared
// decisions a family must not re-derive: where the manifest is, which profile
// is selected, what the envelope's context says, and what gets redacted.

import fs from "node:fs";
import path from "node:path";
import { manifestRevision, readContextManifest, selectManifestProfile } from "../manifest.mjs";
import { resolvePaths } from "../platform-paths.mjs";
import { ControlError, manifestControlError } from "../control/errors.mjs";
import { createRedactor, manifestSecretValues } from "../control/redact.mjs";

// "sha256:" + hash(stableJson(manifest)): key order never changes it.
export function manifestRevisionOf(manifest) {
  return `sha256:${manifestRevision(manifest)}`;
}

// The revision of whatever is on disk now, or null. Used after a command runs,
// so a mutation's envelope carries the revision the next call should expect.
export function currentManifestRevision(manifestPath) {
  try {
    return manifestRevisionOf(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  } catch {
    return null;
  }
}

export function createCommandContext({ command, table, parsed, env, cwd, stderr, secrets = [], hooks = {} }) {
  const { flags, args, positionals } = parsed;
  const paths = resolvePaths({ env });
  const manifestPath = command.manifest === "none"
    ? null
    : path.resolve(cwd, flags.manifest ?? paths.manifest);
  const secretValues = new Set(secrets);
  let redactor = createRedactor(secretValues);
  const context = { manifestPath, manifestRevision: null, profileId: null, profileReason: null };
  const warnings = [];
  const nextActions = [];
  let manifest = null;
  let criticalDepth = 0;

  const ctx = {
    command,
    table,
    flags,
    args,
    positionals,
    env,
    cwd,
    paths,
    manifestPath,
    hooks,
    context,
    warnings,
    nextActions,
    json: flags.json === true,
    quiet: flags.quiet === true,
    // A command that would need a human (a trust prompt, a hidden secret) must
    // check this and fail with a typed error instead of waiting on stdin.
    canPrompt: flags.noInput !== true && Boolean(hooks.stdinIsTTY),

    resolvePath(value) {
      return path.resolve(cwd, value);
    },

    addSecrets(values) {
      for (const value of values) if (typeof value === "string") secretValues.add(value);
      redactor = createRedactor(secretValues);
    },

    redact(value) {
      return redactor.redact(value);
    },

    // Runs when the context is created and again before anything is printed,
    // so a command that hands the manifest path straight to a control
    // operation (and never calls readManifest) still has its tokenEnv values
    // scrubbed from logs and output. Parse only: an invalid manifest
    // must not stop an error about it from printing.
    collectManifestSecrets() {
      if (!manifestPath) return;
      try {
        ctx.addSecrets(manifestSecretValues(JSON.parse(fs.readFileSync(manifestPath, "utf8")), env));
      } catch {
        // Missing or unparseable: nothing it names can be in the output.
      }
    },

    // Reads and validates the manifest once; missing and invalid manifests
    // become typed errors with the init hint. Adds every tokenEnv value the
    // manifest names to the redaction list before anything can print.
    readManifest({ validatePacks = false } = {}) {
      if (manifest) return manifest;
      if (!manifestPath) throw new Error(`${command.id} declared manifest: "none" but read the manifest.`);
      if (!fs.existsSync(manifestPath)) {
        throw new ControlError("MANIFEST_NOT_FOUND", `No manifest at ${manifestPath}. Run 'contextcake init' to create one, or pass --manifest.`, {
          status: 404,
          detail: { manifestPath },
        });
      }
      try {
        manifest = readContextManifest(manifestPath, { allowMissing: false, validatePacks });
      } catch (error) {
        throw manifestControlError(error);
      }
      ctx.addSecrets(manifestSecretValues(manifest, env));
      context.manifestRevision = manifestRevisionOf(manifest);
      return manifest;
    },

    // Profile selection precedence (spec §5.3): --profile, then the project
    // mapping for --cwd or the working directory, then default. The selected
    // identity lands in the envelope context; hand selection.profileId to
    // every control operation rather than letting one derive its own.
    selectProfile() {
      const current = ctx.readManifest();
      let selection;
      try {
        selection = selectManifestProfile(current, {
          requestedProfile: flags.profile ?? null,
          cwd: flags.cwd ? path.resolve(cwd, flags.cwd) : cwd,
        });
      } catch (error) {
        throw manifestControlError(error);
      }
      context.profileId = selection.profileId;
      context.profileReason = selection.reason;
      for (const warning of selection.warnings) {
        if (warning.code !== "pending-source") ctx.warn(warning.code, warning.message ?? warning.code, warning);
      }
      return selection;
    },

    setContext(partial) {
      Object.assign(context, partial);
    },

    warn(code, message, details = null) {
      warnings.push({ code, message, ...(details ? { details } : {}) });
    },

    // A next step is only offered when its command exists in this build:
    // families absent from the table are absent from advice too.
    suggest(commandId, run, description = "") {
      if (!table.byId.has(commandId)) return;
      nextActions.push({ command: commandId, run, ...(description ? { description } : {}) });
    },

    log(message) {
      if (ctx.quiet) return;
      stderr.write(`${redactor.redactString(String(message))}\n`);
    },

    // An interrupt that arrives inside fn is held until fn settles, so a
    // command is never cut between a journal write and its completion marker.
    async critical(fn) {
      criticalDepth += 1;
      try {
        return await fn();
      } finally {
        criticalDepth -= 1;
      }
    },
    get inCriticalSection() {
      return criticalDepth > 0;
    },
  };
  ctx.collectManifestSecrets();
  return ctx;
}
