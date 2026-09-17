// `contextcake source` (control-plane spec §5.4, §5.12). A shim over
// control/sources.mjs, the operations POST/PATCH/DELETE /api/sources,
// PUT /api/sources/order, and POST /api/sources/sync already run. Parse
// flags, select one profile, call one operation, shape the answer.
//
// Config-only commands never build an adapter. `test` and `sync` open one
// selected-profile session through withSourceSession, which closes every
// source and child process in `finally`.
//
// CLI kinds follow the manifest's source kinds, plus `git` for a managed
// clone: okf-local and files (a folder), github (read over the REST API, no
// clone), git (cloned into the manifest's managed clone folder), mcp.

import {
  createSourceOperations,
  testSources,
  withSourceSession,
} from "../../control/sources.mjs";
import { ControlError, manifestControlError } from "../../control/errors.mjs";
import { MANIFEST_REVISION } from "../../control/profiles.mjs";
import { defineFamily } from "../table.mjs";

// What each CLI kind is called by the operation (the app's add-form kinds).
const OPERATION_KIND = { "okf-local": "local", files: "files", github: "github-rest", git: "github", mcp: "mcp" };

const SOURCE_RECORD = {
  type: "object",
  required: ["name", "kind", "level", "rank"],
  properties: {
    name: { type: "string" },
    kind: { enum: ["okf-local", "files", "github", "mcp"] },
    level: { type: "integer" },
    rank: { type: "integer", description: "1 wins over every other source." },
    path: { type: "string" },
    resolvedPath: { type: "string" },
    repo: { type: "string" },
    ref: { type: "string" },
    paths: { type: "array", items: { type: "string" } },
    command: { type: "string" },
    args: { type: "array", items: { type: "string" } },
    origin: { type: "string" },
    auth: { description: "A credential reference ({tokenEnv} or keychain:alias), never a secret." },
    live: { type: "boolean" },
    clone: { type: "object", required: ["dir", "exists"] },
  },
};

const QUARANTINED_RECORD = {
  type: "object",
  required: ["name", "kind", "level", "error"],
  properties: { name: { type: "string" }, kind: { type: "string" }, level: { type: "integer" }, error: { type: "string" } },
};

const PENDING_RECORD = {
  type: "object",
  required: ["name", "kind", "missing"],
  properties: {
    name: { type: "string" },
    kind: { type: "string" },
    level: { type: ["integer", "null"] },
    missing: { type: "array", items: { type: "object", required: ["field", "reason"] } },
    apiBase: { type: "string", description: "Where a GitHub source, and any token it holds, is sent." },
    auth: { description: "A credential reference, never a secret." },
  },
};

const ADD_ERRORS = [
  "NAME_INVALID", "SOURCE_EXISTS", "LEVEL_INVALID", "POSITION_INVALID", "LEVEL_AND_POSITION",
  "PATH_REQUIRED", "FOLDER_NOT_FOUND", "NOT_A_FOLDER", "KIND_UNKNOWN",
  "REPO_INVALID", "PATHS_INVALID", "REPO_NOT_PUBLIC", "REPO_NOT_FOUND", "REST_AUTH_REJECTED",
  "SUBDIR_ESCAPES", "GIT_FAILED", "CLONE_DIR_OCCUPIED", "CLONE_MISSING",
  "MCP_COMMAND_REQUIRED", "MCP_TRUST_REQUIRED", "MCP_CONTRACT", "MCP_UNREACHABLE",
];

function operations(ctx) {
  return createSourceOperations({ manifestPath: ctx.manifestPath, retainClones: true, acceptTokenEnv: true, env: ctx.env });
}

// Sources read the manifest the way the service does: a malformed layer is a
// row, not a failure, so the commands that list or repair it still run.
function selectProfile(ctx) {
  ctx.readManifest({ tolerant: true });
  return ctx.selectProfile();
}

// Operations throw typed errors for everything a user can act on; a plain
// error from the manifest layer (a busy lock, an unknown profile) gets its
// code here.
async function call(fn) {
  try {
    return await fn();
  } catch (error) {
    throw manifestControlError(error);
  }
}

// A manifest write: the envelope reports the revision the operation wrote
// under the lock, never a later read that could see someone else's write.
async function written(ctx, fn) {
  const data = await call(fn);
  ctx.noteManifestWrite(data[MANIFEST_REVISION]);
  return data;
}

function invalid(message) {
  return new ControlError("INVALID_INPUT", message, { status: 400 });
}

function warnExecutable(ctx, command, args) {
  // Trust records arrive with milestone 5. Until then the envelope says out
  // loud what this entry does.
  ctx.warn(
    "MCP_SOURCE_RUNS_COMMAND",
    `This source runs "${[command, ...args].join(" ")}" as you, whenever a client reads this profile. Add only commands you trust.`,
    { command, args },
  );
}

function warnFolder(ctx, result) {
  if (result.hasDocuments === false && result.scanComplete === true) {
    ctx.warn("NO_DOCUMENTS", "No documents were found in that folder yet.");
  }
}

function tokenEnvAuth(ctx) {
  const name = ctx.flags.tokenEnv;
  if (name === undefined) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw invalid("--token-env must name an environment variable.");
  return { tokenEnv: name };
}

// Which kind an add means, and the flags that kind does not take.
function addKind(ctx) {
  const { kind, path, repo, command } = ctx.flags;
  let resolved = kind;
  if (resolved === undefined) {
    const given = [path !== undefined && "files", repo !== undefined && "github", command !== undefined && "mcp"].filter(Boolean);
    if (given.length !== 1) throw invalid("Say what to add with exactly one of --path, --repo, or --command (or pass --kind).");
    resolved = given[0];
  }
  if (!Object.hasOwn(OPERATION_KIND, resolved)) {
    throw new ControlError("KIND_UNKNOWN", `Unknown source kind: ${resolved}. Use okf-local, files, github, git, or mcp.`, { status: 400 });
  }
  const allowed = {
    "okf-local": ["path"],
    files: ["path"],
    github: ["repo", "ref", "include", "tokenEnv"],
    git: ["repo", "ref", "subdir"],
    mcp: ["command", "trusted"],
  }[resolved];
  for (const flag of ["path", "repo", "ref", "subdir", "include", "tokenEnv", "command", "trusted"]) {
    if (ctx.flags[flag] !== undefined && !allowed.includes(flag)) {
      throw invalid(`--${flag.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} does not apply to a ${resolved} source.`);
    }
  }
  if (resolved !== "mcp" && ctx.args.args?.length) throw invalid("Arguments after -- are only for an mcp source.");
  return resolved;
}

function levelText(result) {
  return result.order ? `Cascade: ${result.order.map((entry) => `${entry.name} (${entry.level})`).join(" > ")}` : null;
}

export default defineFamily({
  name: "source",
  stability: "experimental",
  summary: "list, add, change, order, test, and sync a profile's sources",
  commands: [
    {
      name: "list",
      summary: "list the selected profile's sources in cascade order, with invalid and pending entries",
      mutation: "read",
      manifest: "required",
      profile: true,
      output: {
        type: "object",
        required: ["sources", "quarantined", "pending"],
        properties: {
          sources: { type: "array", items: SOURCE_RECORD },
          quarantined: { type: "array", items: QUARANTINED_RECORD },
          pending: { type: "array", items: PENDING_RECORD },
        },
      },
      async run(ctx) {
        const selection = selectProfile(ctx);
        const data = await call(() => operations(ctx).listSources({ profileId: selection.profileId }));
        if (data.pending.length) ctx.suggest("source.pending-list", "contextcake source pending-list", "See what pending sources still need.");
        const lines = [
          ...data.sources.map((source) => `${source.rank}. ${source.name}\t${source.kind}\tlevel ${source.level}`),
          ...data.quarantined.map((row) => `!  ${row.name}\tinvalid: ${row.error}`),
          ...data.pending.map((row) => `…  ${row.name}\tpending: needs ${row.missing.map((entry) => entry.field).join(", ")}`),
        ];
        return { data, text: lines.length ? lines.join("\n") : "No sources in this profile." };
      },
    },
    {
      name: "show",
      summary: "show one source's configuration",
      mutation: "read",
      manifest: "required",
      profile: true,
      positionals: [{ name: "name", required: true, description: "Source name." }],
      errors: ["SOURCE_NOT_FOUND"],
      output: {
        type: "object",
        required: ["state", "source"],
        properties: {
          state: { enum: ["active", "quarantined", "pending"] },
          source: { oneOf: [SOURCE_RECORD, QUARANTINED_RECORD, PENDING_RECORD] },
        },
      },
      async run(ctx) {
        const selection = selectProfile(ctx);
        const listing = await call(() => operations(ctx).listSources({ profileId: selection.profileId }));
        const name = ctx.args.name;
        const found = [
          ["active", listing.sources],
          ["quarantined", listing.quarantined],
          ["pending", listing.pending],
        ].map(([state, rows]) => [state, rows.find((row) => row.name === name)]).find(([, row]) => row);
        if (!found) throw new ControlError("SOURCE_NOT_FOUND", `No source named "${name}"`, { status: 404 });
        const [state, source] = found;
        const text = Object.entries(source).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
        return { data: { state, source }, text: [`${name} (${state})`, ...text].join("\n") };
      },
    },
    {
      name: "add",
      summary: "add a folder, GitHub repository, clone, or MCP server as a source",
      mutation: "write",
      manifest: "required",
      profile: true,
      preconditions: ["manifest-revision"],
      positionals: [
        { name: "name", required: true, description: "Source name: letters, numbers, spaces, _ or -, up to 40." },
        { name: "args", variadic: true, description: "For --kind mcp: the command's arguments, after --." },
      ],
      flags: {
        kind: { type: "string", description: "okf-local, files, github, git, or mcp. Inferred from --path, --repo, or --command." },
        path: { type: "string", description: "Folder to read (files, okf-local)." },
        repo: { type: "string", description: "owner/name (github), or owner/name, https, or git@ URL (git)." },
        ref: { type: "string", description: "Branch or tag (github, git)." },
        include: { type: "string", repeatable: true, description: "Repository path to read (github); repeat for more." },
        subdir: { type: "string", description: "Folder inside the clone to read (git)." },
        "token-env": { type: "string", description: "Environment variable holding a GitHub token (github)." },
        command: { type: "string", description: "Executable that serves the graph over stdio MCP (mcp)." },
        trusted: { type: "boolean", description: "Confirm the MCP command came from a trusted source. Required for mcp." },
        level: { type: "integer", description: "Raw cascade level; higher wins. Defaults to 1." },
        position: { type: "integer", description: "Rank to insert at instead of --level; 1 wins over every source." },
      },
      errors: ADD_ERRORS,
      output: {
        type: "object",
        required: ["ok", "added", "level", "indexing"],
        properties: {
          ok: { const: true },
          added: { type: "string" },
          level: { type: "integer" },
          indexing: { type: "boolean" },
          order: { type: "array", items: { type: "object", required: ["name", "level"] } },
          hasDocuments: { type: "boolean" },
          scanComplete: { type: "boolean" },
          tokenEnvSet: { type: "boolean" },
        },
      },
      async run(ctx) {
        const selection = selectProfile(ctx);
        const kind = addKind(ctx);
        const { flags } = ctx;
        const body = { name: ctx.args.name, kind: OPERATION_KIND[kind] };
        if (flags.level !== undefined) body.level = flags.level;
        if (flags.position !== undefined) body.position = flags.position;
        if (flags.path !== undefined) body.path = flags.path;
        if (flags.repo !== undefined) body.repo = flags.repo;
        if (flags.ref !== undefined) body.ref = flags.ref;
        if (flags.subdir !== undefined) body.subdir = flags.subdir;
        if (flags.include !== undefined) body.paths = flags.include;
        const auth = tokenEnvAuth(ctx);
        if (auth) body.auth = auth;
        if (kind === "mcp") {
          body.command = flags.command;
          body.args = ctx.args.args ?? [];
          body.trusted = flags.trusted === true;
          if (flags.command !== undefined) warnExecutable(ctx, flags.command, body.args);
        }
        // A relative folder means relative to where the command runs, not to
        // the manifest the operation resolves against.
        if (body.path !== undefined && !body.path.startsWith("~")) body.path = ctx.resolvePath(body.path);
        const data = await written(ctx, () => operations(ctx).addSource(body, { profileId: selection.profileId, expectRevision: flags.expectRevision, signal: ctx.signal }));
        warnFolder(ctx, data);
        if (data.tokenEnvSet === false) {
          ctx.warn("TOKEN_ENV_UNSET", `${flags.tokenEnv} is not set here, so the repository was not checked. Set it wherever this source is read.`, { tokenEnv: flags.tokenEnv });
        }
        ctx.suggest("source.test", `contextcake source test ${JSON.stringify(data.added)}`, "Read the new source once and report what came back.");
        return { data, text: [`Added ${data.added} at level ${data.level}.`, levelText(data)].filter(Boolean).join("\n") };
      },
    },
    {
      name: "update",
      summary: "point a folder source somewhere else, rename a source, or change its level",
      mutation: "write",
      manifest: "required",
      profile: true,
      preconditions: ["manifest-revision"],
      positionals: [{ name: "name", required: true, description: "Source name." }],
      flags: {
        path: { type: "string", description: "New folder (files and okf-local sources only)." },
        rename: { type: "string", description: "New name." },
        level: { type: "integer", description: "New raw cascade level." },
      },
      errors: ["SOURCE_NOT_FOUND", "LEVEL_INVALID", "PATH_REQUIRED", "PATCH_REFUSED", "FOLDER_NOT_FOUND", "NOT_A_FOLDER", "NAME_INVALID", "NAME_EXISTS"],
      output: {
        type: "object",
        required: ["ok"],
        properties: { ok: { const: true }, reindexing: { type: "boolean" }, hasDocuments: { type: "boolean" }, scanComplete: { type: "boolean" } },
      },
      async run(ctx) {
        const selection = selectProfile(ctx);
        const { path, rename, level, expectRevision } = ctx.flags;
        if (path === undefined && rename === undefined && level === undefined) throw invalid("Nothing to change: pass --path, --rename, or --level.");
        const body = { name: ctx.args.name };
        if (path !== undefined) body.path = path.startsWith("~") ? path : ctx.resolvePath(path);
        if (rename !== undefined) body.newName = rename;
        if (level !== undefined) body.level = level;
        const data = await written(ctx, () => operations(ctx).patchSource(body, { profileId: selection.profileId, expectRevision }));
        warnFolder(ctx, data);
        return { data, text: `Updated ${rename ?? ctx.args.name}.${data.reindexing ? " It will be read again from the new folder." : ""}` };
      },
    },
    {
      name: "level",
      summary: "set one source's raw cascade level",
      mutation: "write",
      manifest: "required",
      profile: true,
      preconditions: ["manifest-revision"],
      positionals: [
        { name: "name", required: true, description: "Source name." },
        { name: "level", required: true, description: "Integer level; higher wins. Put a negative level after --." },
      ],
      errors: ["SOURCE_NOT_FOUND", "LEVEL_INVALID"],
      output: { type: "object", required: ["ok"], properties: { ok: { const: true } } },
      async run(ctx) {
        const selection = selectProfile(ctx);
        const data = await written(ctx, () => operations(ctx).patchSource({ name: ctx.args.name, level: ctx.args.level }, { profileId: selection.profileId, expectRevision: ctx.flags.expectRevision }));
        return { data, text: `${ctx.args.name} is now at level ${ctx.args.level}.` };
      },
    },
    {
      name: "reorder",
      summary: "set the whole cascade order; name every source, first wins",
      mutation: "write",
      manifest: "required",
      profile: true,
      preconditions: ["manifest-revision"],
      positionals: [{ name: "names", required: true, variadic: true, description: "Every source in the profile, highest precedence first." }],
      errors: ["ORDER_INVALID", "REORDER_BLOCKED"],
      output: {
        type: "object",
        required: ["ok", "order"],
        properties: { ok: { const: true }, order: { type: "array", items: { type: "object", required: ["name", "level"] } } },
      },
      async run(ctx) {
        const selection = selectProfile(ctx);
        const data = await written(ctx, () => operations(ctx).reorderSources({ order: ctx.args.names }, { profileId: selection.profileId, expectRevision: ctx.flags.expectRevision }));
        return { data, text: levelText(data) };
      },
    },
    {
      name: "remove",
      summary: "remove sources from the profile; files and managed clones stay on disk",
      mutation: "write",
      manifest: "required",
      profile: true,
      preconditions: ["manifest-revision"],
      positionals: [{ name: "names", required: true, variadic: true, description: "Sources to remove. Invalid sources can be removed too, and must be removed together." }],
      errors: ["SOURCE_NOT_FOUND", "REMOVE_BLOCKED", "MANIFEST_UNREPAIRABLE", "NAME_REQUIRED"],
      output: {
        type: "object",
        required: ["ok", "removed", "removedNames"],
        properties: {
          ok: { const: true },
          removed: { type: "string" },
          removedNames: { type: "array", items: { type: "string" } },
          retainedClones: { type: "array", items: { type: "string" } },
        },
      },
      async run(ctx) {
        const selection = selectProfile(ctx);
        const data = await written(ctx, () => operations(ctx).removeSources(ctx.args.names, { profileId: selection.profileId, expectRevision: ctx.flags.expectRevision }));
        const lines = [`Removed ${data.removedNames.join(", ")}.`];
        if (data.retainedClones) {
          lines.push(`Kept ${data.retainedClones.length} managed clone(s) no source uses: ${data.retainedClones.join(", ")}`);
          ctx.suggest("source.prune", "contextcake source prune --confirm", "Delete managed clones no source uses.");
        }
        return { data, text: lines.join("\n") };
      },
    },
    {
      name: "test",
      summary: "read each source once and report what came back",
      mutation: "read",
      manifest: "required",
      profile: true,
      coverage: true,
      requireComplete: true,
      positionals: [{ name: "names", variadic: true, description: "Sources to test. Defaults to every source in the profile." }],
      flags: { "source-timeout": { type: "integer", description: "Milliseconds each source may take. Default 30000." } },
      errors: ["SOURCE_NOT_FOUND"],
      output: {
        type: "object",
        required: ["sources"],
        properties: {
          sources: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "kind", "ok", "concepts"],
              properties: {
                name: { type: "string" },
                kind: { type: "string" },
                level: { type: ["integer", "null"] },
                ok: { type: "boolean" },
                concepts: { type: "integer" },
                durationMs: { type: "integer" },
                error: { type: "string" },
                quarantined: { type: "boolean" },
                truncated: { type: "object" },
              },
            },
          },
        },
      },
      async run(ctx) {
        const selection = selectProfile(ctx);
        const timeoutMs = ctx.flags.sourceTimeout ?? 30_000;
        if (timeoutMs < 1) throw invalid("--source-timeout must be at least 1.");
        const result = await call(() => withSourceSession(
          { manifestPath: ctx.manifestPath, profileId: selection.profileId, onClose: (close) => ctx.onClose?.(close), names: ctx.args.names?.length ? ctx.args.names : null },
          ({ entries }) => {
            for (const { layer } of entries) {
              if (layer.source === "mcp" && typeof layer.command === "string") warnExecutable(ctx, layer.command, layer.args ?? []);
            }
            return testSources(entries, { timeoutMs, signal: ctx.signal });
          },
        ));
        const data = { sources: result.sources };
        const text = result.sources.length
          ? result.sources.map((row) => `${row.ok ? "ok  " : "FAIL"} ${row.name}\t${row.concepts} concept(s)${row.error ? `\t${row.error}` : ""}`).join("\n")
          : "No sources in this profile.";
        // requireComplete: an explicit test is a question about health, so a
        // partial answer exits 6 with the degraded sources in the details (§5.2).
        return { data, text, coverage: result.coverage };
      },
    },
    {
      name: "sync",
      summary: "pull a GitHub, clone, or live team source now",
      mutation: "write",
      manifest: "required",
      profile: true,
      positionals: [{ name: "name", required: true, description: "Source name." }],
      errors: ["SOURCE_NOT_FOUND", "SYNC_UNSUPPORTED", "SYNC_FAILED", "GIT_FAILED", "REPO_INVALID", "CLONE_DIR_OCCUPIED"],
      output: {
        type: "object",
        required: ["ok", "synced"],
        properties: {
          ok: { const: true },
          synced: { type: "string" },
          concepts: { type: "integer" },
          lastSynced: {},
          lastSuccessAt: {},
          lastError: {},
          lastErrorAt: {},
        },
      },
      async run(ctx) {
        const selection = selectProfile(ctx);
        const name = ctx.args.name;
        const ops = operations(ctx);
        const data = await call(() => withSourceSession(
          { manifestPath: ctx.manifestPath, profileId: selection.profileId, onClose: (close) => ctx.onClose?.(close), names: [name] },
          ({ layers, entries }) => ops.syncSource(name, { layers, sources: entries.map((entry) => entry.source).filter(Boolean), signal: ctx.signal }),
        ));
        return { data, text: `Synced ${name}${data.concepts !== undefined ? `: ${data.concepts} concept(s)` : ""}.` };
      },
    },
    {
      name: "prune",
      summary: "delete managed clones no source uses; never a clone with local changes",
      mutation: "destructive",
      manifest: "required",
      preconditions: ["confirm"],
      flags: { confirm: { type: "boolean", description: "Delete. Without it the command only lists what would go." } },
      output: {
        type: "object",
        required: ["cacheDir", "removable", "kept", "removed", "confirmed"],
        properties: {
          cacheDir: { type: "string" },
          removable: { type: "array", items: { type: "object", required: ["dir"] } },
          kept: { type: "array", items: { type: "object", required: ["dir", "reason"], properties: { reason: { enum: ["referenced", "dirty", "unpushed", "in-progress", "unreadable"] }, movedTo: { type: "string" } } } },
          removed: { type: "array", items: { type: "object", required: ["dir"] } },
          confirmed: { type: "boolean" },
        },
      },
      async run(ctx) {
        ctx.readManifest({ tolerant: true });
        const confirm = ctx.flags.confirm === true;
        const data = await call(() => operations(ctx).pruneClones({ confirm }));
        const kept = data.kept.map((entry) => `kept ${entry.dir} (${entry.reason})`);
        if (!confirm && data.removable.length) {
          const error = new ControlError("CONFIRMATION_REQUIRED", `Pruning ${data.removable.length} clone(s) needs --confirm.`, { status: 409, detail: data });
          error.text = [...data.removable.map((entry) => `would delete ${entry.dir}`), ...kept, "Re-run with --confirm."].join("\n");
          throw error;
        }
        const lines = [...data.removed.map((entry) => `deleted ${entry.dir}`), ...kept];
        return { data, text: lines.length ? lines.join("\n") : "No managed clones." };
      },
    },
    {
      name: "pending-list",
      summary: "list sources waiting for this machine's path, command, or credential",
      mutation: "read",
      manifest: "required",
      profile: true,
      output: { type: "array", items: PENDING_RECORD },
      async run(ctx) {
        const selection = selectProfile(ctx);
        const data = await call(() => operations(ctx).listPendingSources({ profileId: selection.profileId }));
        for (const row of data) {
          ctx.suggest("source.pending-configure", `contextcake source pending-configure ${JSON.stringify(row.name)}`, `Supply ${row.missing.map((entry) => entry.field).join(", ") || "nothing"} for ${row.name}.`);
        }
        const text = data.length
          ? data.map((row) => `${row.name}\t${row.kind}\tneeds ${row.missing.map((entry) => entry.field).join(", ") || "nothing"}`).join("\n")
          : "No pending sources.";
        return { data, text };
      },
    },
    {
      name: "pending-configure",
      summary: "supply what a pending source needs on this machine and make it a source",
      mutation: "write",
      manifest: "required",
      profile: true,
      preconditions: ["manifest-revision"],
      positionals: [
        { name: "name", required: true, description: "Pending source name." },
        { name: "args", variadic: true, description: "For an mcp source: the command's arguments, after --." },
      ],
      flags: {
        path: { type: "string", description: "Folder on this machine." },
        command: { type: "string", description: "MCP command on this machine. Replaces the whole invocation." },
        trusted: { type: "boolean", description: "Confirm the MCP command came from a trusted source." },
        "token-env": { type: "string", description: "Environment variable holding a GitHub token." },
        "api-base": { type: "string", description: "Restate the API address a GitHub source with a token reads from. Required when it is not api.github.com." },
        level: { type: "integer", description: "Raw cascade level. Defaults to the pending entry's, else 1." },
      },
      errors: [
        "PENDING_NOT_FOUND", "PENDING_INCOMPLETE", "PENDING_INVALID", "API_BASE_UNCONFIRMED", "STALE", "SOURCE_EXISTS", "LEVEL_INVALID", "PATH_REQUIRED",
        "FOLDER_NOT_FOUND", "NOT_A_FOLDER", "REST_AUTH_REJECTED", "REPO_NOT_PUBLIC", "REPO_NOT_FOUND",
        "MCP_TRUST_REQUIRED", "MCP_CONTRACT", "MCP_UNREACHABLE",
      ],
      output: {
        type: "object",
        required: ["ok", "configured", "kind", "level"],
        properties: { ok: { const: true }, configured: { type: "string" }, kind: { type: "string" }, level: { type: "integer" }, hasDocuments: { type: "boolean" }, scanComplete: { type: "boolean" } },
      },
      async run(ctx) {
        const selection = selectProfile(ctx);
        const { flags } = ctx;
        const supplied = {};
        if (flags.path !== undefined) supplied.path = flags.path.startsWith("~") ? flags.path : ctx.resolvePath(flags.path);
        if (flags.command !== undefined) supplied.command = flags.command;
        if (ctx.args.args?.length) {
          if (flags.command === undefined) throw invalid("Arguments after -- need --command.");
          supplied.args = ctx.args.args;
        }
        if (flags.trusted) supplied.trusted = true;
        const auth = tokenEnvAuth(ctx);
        if (auth) supplied.auth = auth;
        if (flags.level !== undefined) supplied.level = flags.level;
        if (flags.apiBase !== undefined) supplied.apiBase = flags.apiBase;
        if (supplied.command !== undefined) warnExecutable(ctx, supplied.command, supplied.args ?? []);
        const data = await written(ctx, () => operations(ctx).configurePendingSource(ctx.args.name, supplied, { profileId: selection.profileId, expectRevision: flags.expectRevision, signal: ctx.signal }));
        warnFolder(ctx, data);
        ctx.suggest("source.test", `contextcake source test ${JSON.stringify(data.configured)}`, "Read the source once and report what came back.");
        return { data, text: `Configured ${data.configured} (${data.kind}) at level ${data.level}.` };
      },
    },
    {
      name: "pending-dismiss",
      summary: "discard pending sources without configuring them",
      mutation: "write",
      manifest: "required",
      profile: true,
      preconditions: ["manifest-revision"],
      positionals: [{ name: "names", required: true, variadic: true, description: "Pending sources to discard." }],
      errors: ["PENDING_NOT_FOUND", "REMOVE_BLOCKED", "MANIFEST_UNREPAIRABLE", "NAME_REQUIRED"],
      output: {
        type: "object",
        required: ["ok", "removed", "removedNames"],
        properties: { ok: { const: true }, removed: { type: "string" }, removedNames: { type: "array", items: { type: "string" } } },
      },
      async run(ctx) {
        const selection = selectProfile(ctx);
        const data = await written(ctx, () => operations(ctx).removeSources(ctx.args.names, { profileId: selection.profileId, expectRevision: ctx.flags.expectRevision, pendingOnly: true }));
        return { data, text: `Dismissed ${data.removedNames.join(", ")}.` };
      },
    },
  ],
});
