// `contextcake profile` (control-plane spec §5.3). A shim over
// control/profiles.mjs: parse, call one operation, shape the result. The
// human text for the original six commands is the text profile-cli.mjs prints.

import {
  PROFILE_TEXT,
  cloneProfile,
  createProfile,
  currentProfile,
  deleteProfile,
  listProfiles,
  mapProject,
  purgeProfileState,
  renameProfile,
  showProfile,
  unmapProject,
} from "../../control/profiles.mjs";
import { ControlError } from "../../control/errors.mjs";
import { defineFamily } from "../table.mjs";

const PROFILE_SUMMARY = {
  type: "object",
  required: ["id", "label", "sourceCount", "mappingCount", "mode", "valid"],
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    sourceCount: { type: "integer" },
    pendingSourceCount: { type: "integer" },
    mappingCount: { type: "integer" },
    mode: { enum: ["legacy", "transitional", "v2"] },
    valid: { type: "boolean" },
  },
};

const DELETE_PREVIEW = {
  type: "object",
  required: ["profileId", "mappings", "packAssignments", "sourceCount", "deleted"],
  properties: {
    profileId: { type: "string" },
    mappings: { type: "array", items: { type: "string" } },
    packAssignments: { type: "array", items: { type: "string" } },
    sourceCount: { type: "integer" },
    deleted: { type: "boolean" },
    retiredState: { type: "string" },
  },
};

function confirmationRequired(message, detail, text) {
  const error = new ControlError("CONFIRMATION_REQUIRED", message, { status: 409, detail });
  // Printed to stdout in human mode, as profile-cli.mjs always has.
  error.text = text;
  return error;
}

export default defineFamily({
  name: "profile",
  stability: "experimental",
  summary: "inspect and manage project profiles",
  commands: [
    {
      name: "current",
      summary: "show the selected profile and why it was selected",
      mutation: "read",
      manifest: "required",
      profile: true,
      output: {
        type: "object",
        required: ["id", "label", "reason", "mode", "sourceCount"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          reason: { enum: ["explicit", "project", "default", "legacy-default"] },
          mode: { enum: ["legacy", "transitional", "v2"] },
          sourceCount: { type: "integer" },
          matchedProjectRoot: { type: "string" },
        },
      },
      run(ctx) {
        ctx.readManifest();
        const data = currentProfile({ manifestPath: ctx.manifestPath, profile: ctx.flags.profile, cwd: ctx.flags.cwd ? ctx.resolvePath(ctx.flags.cwd) : ctx.cwd });
        ctx.setContext({ profileId: data.id, profileReason: data.reason });
        return { data, text: PROFILE_TEXT.current(data) };
      },
    },
    {
      name: "list",
      summary: "list profiles without opening sources",
      mutation: "read",
      manifest: "required",
      output: { type: "array", items: PROFILE_SUMMARY },
      run(ctx) {
        ctx.readManifest();
        const data = listProfiles({ manifestPath: ctx.manifestPath });
        return { data, text: PROFILE_TEXT.list(data) };
      },
    },
    {
      name: "show",
      summary: "show one profile's sources, mappings, Packs, and state folder",
      mutation: "read",
      manifest: "required",
      profile: true,
      positionals: [{ name: "id", description: "Profile id. Defaults to the selected profile." }],
      output: {
        type: "object",
        required: ["id", "label", "mode", "sources", "pendingSources", "projects", "packs", "state"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          reason: { type: "string" },
          mode: { enum: ["legacy", "transitional", "v2"] },
          sources: { type: "array", items: { type: "object", required: ["name", "kind", "level"] } },
          pendingSources: { type: "array", items: { type: "object", required: ["name", "kind"] } },
          projects: { type: "array", items: { type: "string" } },
          packs: { type: "array", items: { type: "object", required: ["packId", "layerName", "version", "level"] } },
          state: { type: "object", required: ["dir", "exists"] },
        },
      },
      run(ctx) {
        ctx.readManifest();
        if (ctx.args.id && ctx.flags.profile && ctx.args.id !== ctx.flags.profile) {
          throw new ControlError("INVALID_INPUT", "Pass the profile id or --profile, not two different ids.", { status: 400 });
        }
        const data = showProfile({
          manifestPath: ctx.manifestPath,
          profile: ctx.args.id ?? ctx.flags.profile ?? null,
          cwd: ctx.flags.cwd ? ctx.resolvePath(ctx.flags.cwd) : ctx.cwd,
        });
        ctx.setContext({ profileId: data.id, profileReason: data.reason });
        const lines = [
          `${data.label} (${data.id}) — ${data.reason}`,
          `Sources: ${data.sources.length ? data.sources.map((source) => `${source.name} [${source.kind}, level ${source.level}]`).join(", ") : "none"}`,
          ...(data.pendingSources.length ? [`Pending: ${data.pendingSources.map((source) => source.name).join(", ")}`] : []),
          ...(data.projects.length ? [`Projects: ${data.projects.join(", ")}`] : []),
          ...(data.packs.length ? [`Packs: ${data.packs.map((pack) => `${pack.packId}@${pack.version}`).join(", ")}`] : []),
          `State: ${data.state.dir}${data.state.exists ? "" : " (none yet)"}`,
        ];
        return { data, text: lines.join("\n") };
      },
    },
    {
      name: "create",
      summary: "create an empty profile; safely migrate a legacy manifest",
      mutation: "write",
      manifest: "required",
      preconditions: ["manifest-revision"],
      positionals: [{ name: "label", required: true, variadic: true, description: "Profile label; words are joined with spaces." }],
      flags: { project: { type: "string", description: "Map this folder to the new profile." } },
      errors: ["PROJECT_MAPPED", "NOT_FOUND"],
      output: {
        type: "object",
        required: ["created", "label", "action"],
        properties: {
          created: { type: "string" },
          label: { type: "string" },
          action: { enum: ["profile-created", "migrated"] },
          project: { type: "string" },
          backupPath: { type: "string" },
          backupHash: { type: "string" },
        },
      },
      run(ctx) {
        ctx.readManifest();
        const data = createProfile({
          manifestPath: ctx.manifestPath,
          label: ctx.args.label.join(" "),
          project: ctx.flags.project ? ctx.resolvePath(ctx.flags.project) : null,
          expectRevision: ctx.flags.expectRevision,
        });
        ctx.suggest("profile.map", `contextcake profile map ${data.created} <path>`, "Map a project folder to the new profile.");
        return { data, text: PROFILE_TEXT.create(data) };
      },
    },
    {
      name: "rename",
      summary: "change a profile's label; the id never changes",
      mutation: "write",
      manifest: "required",
      preconditions: ["manifest-revision", "manifest-v2"],
      positionals: [
        { name: "id", required: true, description: "Profile id." },
        { name: "label", required: true, variadic: true, description: "New label; words are joined with spaces." },
      ],
      errors: ["MANIFEST_NOT_V2"],
      output: {
        type: "object",
        required: ["id", "label", "previousLabel"],
        properties: { id: { type: "string" }, label: { type: "string" }, previousLabel: { type: "string" } },
      },
      run(ctx) {
        ctx.readManifest();
        const data = renameProfile({ manifestPath: ctx.manifestPath, profileId: ctx.args.id, label: ctx.args.label.join(" "), expectRevision: ctx.flags.expectRevision });
        return { data, text: `Renamed ${data.id}: ${data.previousLabel} -> ${data.label}` };
      },
    },
    {
      name: "clone",
      summary: "copy a profile's configuration; MCP sources arrive pending",
      mutation: "write",
      manifest: "required",
      preconditions: ["manifest-revision", "manifest-v2"],
      positionals: [
        { name: "id", required: true, description: "Profile id to copy." },
        { name: "label", required: true, variadic: true, description: "Label for the copy; words are joined with spaces." },
      ],
      errors: ["MANIFEST_NOT_V2"],
      output: {
        type: "object",
        required: ["created", "label", "from", "sourceCount", "pendingExecutables"],
        properties: {
          created: { type: "string" },
          label: { type: "string" },
          from: { type: "string" },
          sourceCount: { type: "integer" },
          pendingExecutables: { type: "array", items: { type: "string" } },
        },
      },
      run(ctx) {
        ctx.readManifest();
        const data = cloneProfile({ manifestPath: ctx.manifestPath, profileId: ctx.args.id, label: ctx.args.label.join(" "), expectRevision: ctx.flags.expectRevision });
        if (data.pendingExecutables.length) {
          ctx.warn("MCP_SOURCES_PENDING", `MCP sources need local setup before they run in ${data.created}.`, { sources: data.pendingExecutables });
        }
        const pending = data.pendingExecutables.length ? `\nPending until configured on this machine: ${data.pendingExecutables.join(", ")}` : "";
        return { data, text: `Cloned ${data.from} to ${data.label} (${data.created}) with ${data.sourceCount} source(s)${pending}` };
      },
    },
    {
      name: "map",
      summary: "map a local project folder to a profile",
      mutation: "write",
      manifest: "required",
      preconditions: ["manifest-revision", "manifest-v2"],
      positionals: [
        { name: "id", required: true, description: "Profile id." },
        { name: "path", required: true, description: "Project folder." },
      ],
      errors: ["MANIFEST_NOT_V2", "PROJECT_MAPPED", "NOT_FOUND"],
      output: { type: "object", required: ["mapped", "profileId"], properties: { mapped: { type: "string" }, profileId: { type: "string" } } },
      run(ctx) {
        ctx.readManifest();
        const data = mapProject({ manifestPath: ctx.manifestPath, profileId: ctx.args.id, projectPath: ctx.resolvePath(ctx.args.path), expectRevision: ctx.flags.expectRevision });
        return { data, text: PROFILE_TEXT.map(data) };
      },
    },
    {
      name: "unmap",
      summary: "remove one project mapping",
      mutation: "write",
      manifest: "required",
      preconditions: ["manifest-revision", "manifest-v2"],
      positionals: [{ name: "path", required: true, description: "Mapped project folder." }],
      errors: ["MANIFEST_NOT_V2", "MAPPING_NOT_FOUND"],
      output: { type: "object", required: ["unmapped"], properties: { unmapped: { type: "string" } } },
      run(ctx) {
        ctx.readManifest();
        const data = unmapProject({ manifestPath: ctx.manifestPath, projectPath: ctx.resolvePath(ctx.args.path), expectRevision: ctx.flags.expectRevision });
        return { data, text: PROFILE_TEXT.unmap(data) };
      },
    },
    {
      name: "delete",
      summary: "remove a profile's references and retire its state; never source files",
      mutation: "write",
      manifest: "required",
      preconditions: ["manifest-revision", "manifest-v2", "confirm"],
      positionals: [{ name: "id", required: true, description: "Profile id." }],
      flags: { confirm: { type: "boolean", description: "Delete. Without it the command only previews." } },
      errors: ["MANIFEST_NOT_V2", "PROFILE_PROTECTED"],
      output: DELETE_PREVIEW,
      run(ctx) {
        ctx.readManifest();
        const data = deleteProfile({ manifestPath: ctx.manifestPath, profileId: ctx.args.id, confirm: ctx.flags.confirm === true, expectRevision: ctx.flags.expectRevision });
        if (!data.deleted) {
          throw confirmationRequired(`Deleting ${data.profileId} needs --confirm.`, data, PROFILE_TEXT.deletePreview(data));
        }
        ctx.suggest("profile.purge-state", `contextcake profile purge-state ${data.profileId} --confirm`, "Permanently remove the retired state.");
        return { data, text: PROFILE_TEXT.deleted(data) };
      },
    },
    {
      name: "purge-state",
      summary: "permanently remove state left by a deleted profile",
      mutation: "destructive",
      manifest: "required",
      preconditions: ["confirm"],
      positionals: [{ name: "id", required: true, description: "Id of a deleted profile." }],
      flags: { confirm: { type: "boolean", description: "Delete. Without it the command only lists what would go." } },
      errors: ["PROFILE_ACTIVE"],
      output: {
        type: "object",
        required: ["profileId", "dirs", "purged"],
        properties: { profileId: { type: "string" }, dirs: { type: "array", items: { type: "string" } }, purged: { type: "boolean" } },
      },
      run(ctx) {
        ctx.readManifest();
        const data = purgeProfileState({ manifestPath: ctx.manifestPath, profileId: ctx.args.id, confirm: ctx.flags.confirm === true });
        if (!data.purged && data.dirs.length) {
          throw confirmationRequired(
            `Purging state for ${data.profileId} needs --confirm.`,
            data,
            `Permanently delete ${data.dirs.length} state folder(s) for ${data.profileId}?\n${data.dirs.join("\n")}\nRe-run with --confirm.`,
          );
        }
        const text = data.dirs.length
          ? `${data.purged ? "Deleted" : "Would delete"} ${data.dirs.length} state folder(s) for ${data.profileId}.`
          : `No state left for ${data.profileId}.`;
        return { data, text };
      },
    },
  ],
});
