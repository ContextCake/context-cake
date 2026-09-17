// `contextcake doctor` checks (control-plane spec §5.2 exit 8, §5.11, §5.12;
// specs/local-diagnostics/spec.md "Headless and documentation").
//
// A fresh, bounded look at this machine: the manifest (and any layer the read
// path would quarantine), the selected profile, whether each source can be
// reached, the config/data/cache directories, and every `contextcake` on
// PATH with the version it reports. It never reads a running engine's
// history and never spawns an executable (MCP) source.
//
// Returns a report plus the fix commands worth suggesting; the CLI family
// decides the envelope and exit code.

import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { NOT_CHECKED } from "../doctor.mjs";
import { manifestRevision, readContextManifestQuarantined, selectManifestProfile } from "../manifest.mjs";
import { resolveSettings } from "../settings.mjs";
import { buildSourcesQuarantined } from "../sources/index.mjs";
import { withDeadline } from "./util.mjs";

const LOCAL_KINDS = new Set(["okf-local", "files"]);
const MAX_PROBED_SOURCES = 100;
const LOCAL_PROBE_MS = 1000;
const REMOTE_PROBE_MS = 5000;
const SOURCE_BUDGET_MS = 15_000;
const VERSION_TIMEOUT_MS = 5000;

function check(id, status, message, details = null) {
  return { id, status, message, ...(details ? { details } : {}) };
}

function readManifestState(manifestPath) {
  if (!fs.existsSync(manifestPath)) return { status: "missing", revision: null };
  let revision = null;
  try {
    revision = `sha256:${manifestRevision(JSON.parse(fs.readFileSync(manifestPath, "utf8")))}`;
  } catch {
    // Unparseable: the quarantined read below reports why.
  }
  try {
    const { manifest, quarantined } = readContextManifestQuarantined(manifestPath, { allowMissing: false, validatePacks: false });
    return { status: quarantined.length ? "quarantined" : "valid", revision, manifest, quarantined };
  } catch (error) {
    return { status: "invalid", revision, error: error.message };
  }
}

async function probeLocal(root, remainingMs) {
  try {
    const stat = await withDeadline(fsp.stat(root), Math.max(1, Math.min(LOCAL_PROBE_MS, remainingMs)), "Folder check timed out");
    return stat.isDirectory() ? { status: "present" } : { status: "not-directory", reason: `Not a folder: ${root}` };
  } catch (error) {
    return { status: "unavailable", reason: error.code === "ENOENT" ? `Folder does not exist: ${root}` : error.message };
  }
}

async function probeRemote(source, remainingMs, stop) {
  const budget = AbortSignal.timeout(Math.max(1, Math.min(REMOTE_PROBE_MS, remainingMs)));
  const signal = stop ? AbortSignal.any([budget, stop]) : budget;
  try {
    await source.listConceptIds({ signal, notes: { skipped: [], unreadable: [], hidden: 0 } });
  } catch (error) {
    stop?.throwIfAborted();
    return { status: "unavailable", reason: error?.message ?? String(error) };
  }
  const health = source.health?.();
  if (health && health.ok === false && health.lastError) return { status: "unavailable", reason: String(health.lastError) };
  return { status: "reachable" };
}

async function probeSources(runtimeManifest, manifestDir, profileId, stop) {
  const layers = runtimeManifest.layers ?? [];
  const sources = buildSourcesQuarantined(runtimeManifest, manifestDir, { profileId });
  const deadline = Date.now() + SOURCE_BUDGET_MS;
  try {
    const rows = [];
    for (const [index, layer] of layers.entries()) {
      stop?.throwIfAborted();
      const kind = layer.source ?? "okf-local";
      const row = { name: layer.name, kind, level: layer.level };
      const remaining = deadline - Date.now();
      if (index >= MAX_PROBED_SOURCES || remaining <= 0) {
        rows.push({ ...row, status: "not-probed", reason: "The diagnostic time or source budget ran out." });
      } else if (LOCAL_KINDS.has(kind)) {
        rows.push({ ...row, ...(await probeLocal(path.resolve(manifestDir, layer.path), remaining)) });
      } else if (kind === "mcp") {
        rows.push({ ...row, status: "not-probed", reason: "Doctor does not start executable sources." });
      } else {
        rows.push({ ...row, ...(await probeRemote(sources[index], remaining, stop)) });
      }
    }
    return rows;
  } finally {
    await Promise.allSettled(sources.map(async (source) => source.close?.()));
  }
}

// Exists and writable, or missing but creatable under a writable ancestor.
async function directoryState(dir) {
  try {
    const stat = await fsp.stat(dir);
    if (!stat.isDirectory()) return { exists: true, writable: false, reason: "Not a folder." };
    await fsp.access(dir, fs.constants.W_OK);
    return { exists: true, writable: true };
  } catch (error) {
    if (error.code !== "ENOENT") return { exists: true, writable: false, reason: error.message };
  }
  let ancestor = path.dirname(dir);
  for (;;) {
    try {
      await fsp.access(ancestor, fs.constants.W_OK);
      return { exists: false, writable: true };
    } catch (error) {
      if (error.code !== "ENOENT") return { exists: false, writable: false, reason: `Cannot create under ${ancestor}: ${error.message}` };
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return { exists: false, writable: false, reason: "No existing parent folder." };
    ancestor = parent;
  }
}

function executableNames(platform) {
  return platform === "win32" ? ["contextcake.cmd", "contextcake.exe", "contextcake"] : ["contextcake"];
}

function runVersion(file, env, platform) {
  return new Promise((resolve) => {
    // .cmd shims only run through the shell on Windows; the path is quoted.
    const [command, args, options] = platform === "win32"
      ? [`"${file}"`, ["--version"], { shell: true }]
      : [file, ["--version"], {}];
    execFile(command, args, { ...options, env, timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      const version = String(stdout ?? "").trim().split(/\r?\n/)[0] || null;
      if (error && !version) resolve({ version: null, error: error.killed ? "Timed out." : error.message });
      else resolve({ version });
    });
  });
}

/**
 * Every `contextcake` on PATH, in PATH order, with its `--version`. Two PATH
 * entries that resolve to the same file are one install listed twice, so
 * `distinct` counts real paths.
 */
export async function findExecutables({ env, platform = process.platform, current = null }) {
  const dirs = String(env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const found = [];
  const seenPaths = new Set();
  for (const dir of dirs) {
    for (const name of executableNames(platform)) {
      const file = path.resolve(dir, name);
      if (seenPaths.has(file)) continue;
      try {
        const stat = await fsp.stat(file);
        if (!stat.isFile()) continue;
        if (platform !== "win32") await fsp.access(file, fs.constants.X_OK);
      } catch {
        continue;
      }
      seenPaths.add(file);
      let realpath = file;
      try { realpath = await fsp.realpath(file); } catch { /* keep the PATH form */ }
      found.push({ path: file, realpath });
    }
  }
  const versions = await Promise.all(found.map((entry) => runVersion(entry.path, env, platform)));
  let currentReal = null;
  if (current) {
    try { currentReal = await fsp.realpath(current); } catch { currentReal = null; }
  }
  return found.map((entry, index) => ({
    ...entry,
    ...versions[index],
    ...(currentReal ? { current: entry.realpath === currentReal } : {}),
  }));
}

/**
 * options: manifestPath, requestedProfile, cwd, env, paths ({config,data,cache}),
 *   version (the running CLI's), entry (the running CLI's script path),
 *   observability (already probed by the caller), platform, signal (stops
 *   the probes when the command times out or is interrupted).
 */
export async function runDoctor({
  manifestPath, requestedProfile = null, cwd, env, paths, version, entry = null,
  observability = null, platform = process.platform, signal = null,
}) {
  const checks = [];
  const suggestions = [];
  const warnings = [];
  const suggest = (command, run, description) => suggestions.push({ command, run, description });

  // Manifest.
  const state = readManifestState(manifestPath);
  const manifest = { path: manifestPath, status: state.status, quarantined: [] };
  if (state.status === "missing") {
    checks.push(check("manifest", "fail", `No manifest at ${manifestPath}.`));
    suggest("init", "contextcake init", "Create an empty manifest.");
  } else if (state.status === "invalid") {
    manifest.error = state.error;
    checks.push(check("manifest", "fail", `The manifest is not valid: ${state.error}`));
  } else {
    manifest.quarantined = state.quarantined.map(({ name, level, profileId, error }) => ({ name, level, profileId, error }));
    if (state.quarantined.length) {
      checks.push(check("manifest", "fail", `${state.quarantined.length} layer(s) are invalid and skipped by every read.`, { quarantined: manifest.quarantined }));
      for (const layer of manifest.quarantined) {
        suggest("source.remove", `contextcake source remove ${layer.name} --profile ${layer.profileId}`, `Remove the invalid layer ${layer.name}.`);
      }
    } else {
      checks.push(check("manifest", "ok", `Valid manifest at ${manifestPath}.`));
    }
  }

  // Profile and sources.
  let profile = null;
  let settings = null;
  let sources = [];
  if (state.manifest) {
    let selection = null;
    try {
      selection = selectManifestProfile(state.manifest, { requestedProfile, cwd });
    } catch (error) {
      checks.push(check("profile", "fail", error.message));
      suggest("profile.list", "contextcake profile list", "See which profiles exist.");
    }
    if (selection) {
      profile = { id: selection.profileId, label: selection.profileLabel, reason: selection.reason, mode: selection.mode };
      checks.push(check("profile", "ok", `Selected ${selection.profileLabel} (${selection.profileId}): ${selection.reason}.`));
      for (const warning of selection.warnings.filter((row) => row.code !== "pending-source")) {
        checks.push(check("profile", "warn", warning.message ?? warning.code, warning));
      }
      const runtimeManifest = { layers: selection.layers, ...(state.manifest.settings ? { settings: state.manifest.settings } : {}) };
      settings = resolveSettings(runtimeManifest);
      sources = await probeSources(runtimeManifest, path.dirname(path.resolve(manifestPath)), selection.profileId, signal);
      if (!sources.length) {
        checks.push(check("sources", "warn", `Profile ${selection.profileId} has no sources.`));
        suggest("source.add", "contextcake source add <name> --path <folder>", "Add a folder of Markdown as a source.");
      }
      for (const source of sources) {
        const label = `${source.name} (${source.kind})`;
        if (source.status === "present" || source.status === "reachable") {
          checks.push(check("source", "ok", `${label}: ${source.status}.`, { source: source.name }));
        } else if (source.status === "not-probed") {
          checks.push(check("source", "warn", `${label}: not probed. ${source.reason}`, { source: source.name }));
        } else {
          checks.push(check("source", "fail", `${label}: ${source.reason}`, { source: source.name }));
          const scope = selection.reason === "explicit" ? ` --profile ${selection.profileId}` : "";
          if (LOCAL_KINDS.has(source.kind)) {
            suggest("source.update", `contextcake source update ${source.name} --path <folder>${scope}`, `Point ${source.name} at a folder that exists.`);
          } else {
            suggest("source.test", `contextcake source test ${source.name}${scope}`, `Retry ${source.name} with details.`);
          }
          suggest("source.remove", `contextcake source remove ${source.name}${scope}`, `Stop reading ${source.name}.`);
        }
      }
    }
  }

  // Directories.
  const directories = [];
  for (const name of ["config", "data", "cache"]) {
    const dir = paths[name];
    const dirState = await directoryState(dir);
    directories.push({ name, path: dir, ...dirState });
    if (dirState.writable) checks.push(check("directory", "ok", `${name}: ${dir}${dirState.exists ? "" : " (created on first use)"}.`, { name }));
    else checks.push(check("directory", "fail", `${name}: ${dir} is not writable. ${dirState.reason ?? ""}`.trim(), { name }));
  }

  // Executables on PATH (spec §5.11): a harness running a bare `contextcake`
  // may start a different engine than the one answering this command.
  const executables = await findExecutables({ env, platform, current: entry });
  const distinct = new Set(executables.map((row) => row.realpath));
  if (!executables.length) {
    checks.push(check("path", "warn", "No contextcake on PATH. Harness configs should name the absolute path of this CLI."));
  } else {
    checks.push(check("path", "ok", `First contextcake on PATH: ${executables[0].path} (${executables[0].version ?? "version unknown"}).`));
  }
  if (distinct.size > 1) {
    warnings.push({
      code: "MULTIPLE_EXECUTABLES",
      message: `${distinct.size} different contextcake installs are on PATH; a harness runs whichever comes first.`,
      details: { paths: executables.map((row) => row.path) },
    });
  }
  if (executables.length && version && version !== "unknown" && executables[0].version !== version) {
    warnings.push({
      code: "PATH_VERSION_MISMATCH",
      message: `The first contextcake on PATH reports ${executables[0].version ?? "no version"}, but this CLI is ${version}.`,
      details: { path: executables[0].path, pathVersion: executables[0].version ?? null, runningVersion: version },
    });
  }
  for (const warning of warnings) checks.push(check("path", "warn", warning.message));

  const coverageRows = sources.map((row) => ({
    name: row.name,
    kind: row.kind,
    status: row.status === "present" || row.status === "reachable" ? "ok" : row.status,
    ...(row.reason ? { reason: row.reason } : {}),
  }));
  const degraded = coverageRows.filter((row) => row.status !== "ok");
  const report = {
    scope: "fresh-configuration-check",
    checkedAt: new Date().toISOString(),
    healthy: !checks.some((row) => row.status === "fail"),
    cli: { version: version ?? null },
    manifest,
    profile,
    settings,
    sources,
    directories,
    executables,
    observability: observability ?? NOT_CHECKED,
    checks,
  };
  return {
    report,
    manifestRevision: state.revision,
    warnings,
    suggestions,
    coverage: {
      complete: degraded.length === 0,
      sources: coverageRows,
      degraded: degraded.map((row) => ({ source: row.name, kind: row.kind, status: row.status, reason: row.reason })),
    },
  };
}
