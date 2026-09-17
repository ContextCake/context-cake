// Profile control operations (control-plane spec §5.3), shared by the
// `contextcake profile` family and the raw `profile-cli.mjs` wrapper.
//
// Config-only: nothing here opens a source adapter. Every mutation runs inside
// the manifest lock, and takes an optional `expectRevision` checked against
// the manifest read under that lock (design §5). A mutation's result carries
// the revision it wrote under MANIFEST_REVISION (a symbol, so it never shows
// up in JSON output); read operations accept the `manifest` an adapter already
// read, so an envelope never describes a different file than the answer.
//
// The original six operations keep the messages profile-runtime-test.sh and
// scripted users already match on; only the error class changed, from Error
// to ControlError, so an adapter can map them to exit codes.

import fs from "node:fs";
import path from "node:path";
import {
  classifyManifest,
  createProfileId,
  listManifestProfiles,
  manifestRevision,
  migrateManifestToV2,
  mutateContextManifest,
  normalizeProfileLabel,
  readContextManifest,
  selectManifestProfile,
  withManifestLock,
  writeContextManifest,
} from "../manifest.mjs";
import { listStaleSidecarDirs, retireSidecarDir, sidecarDir } from "../sidecar-state.mjs";
import { ControlError, manifestControlError } from "./errors.mjs";

// The sha256 hex of the manifest a mutation wrote, attached to its result.
export const MANIFEST_REVISION = Symbol("contextcake.manifestRevision");

// The scrub marker settings sync already uses for a machine-local command:
// validation accepts it, and a source carrying it can never run.
const EXECUTION_SCRUBBED = Object.freeze({ __scrubbed: "execution" });

export function normalizeRevision(value) {
  if (value == null) return null;
  const hex = String(value).replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(hex)) {
    throw new ControlError("INVALID_INPUT", "Expected revision must be sha256:<64 hex digits>.", { status: 400 });
  }
  return hex;
}

export function revisionPrecondition(expectRevision) {
  const expected = normalizeRevision(expectRevision);
  if (!expected) return null;
  return (manifest) => {
    const actual = manifestRevision(manifest);
    if (actual !== expected) {
      throw new ControlError("STALE_REVISION", "The manifest changed since the expected revision. Read it again and retry.", {
        status: 409,
        detail: { expected: `sha256:${expected}`, actual: `sha256:${actual}` },
      });
    }
  };
}

function withRevision(result, revision) {
  Object.defineProperty(result, MANIFEST_REVISION, { value: revision, enumerable: false });
  return result;
}

function guard(operation) {
  try {
    return operation();
  } catch (error) {
    throw manifestControlError(error);
  }
}

function readManifest(manifestPath) {
  return guard(() => readContextManifest(manifestPath, { allowMissing: false, validatePacks: false }));
}

// Runs mutate under the lock and returns [result, revision of what was written].
function mutate(manifestPath, fn, expectRevision) {
  let revision = null;
  const result = guard(() => mutateContextManifest(manifestPath, (manifest) => {
    const value = fn(manifest);
    // mutateContextManifest writes this same object right after we return.
    revision = manifestRevision(manifest);
    return value;
  }, { allowMissing: false, precondition: revisionPrecondition(expectRevision) }));
  return [result, revision];
}

function label(value) {
  try {
    return normalizeProfileLabel(value);
  } catch (error) {
    throw new ControlError("INVALID_INPUT", error.message, { status: 400 });
  }
}

function usage(message) {
  return new ControlError("INVALID_INPUT", message, { status: 400 });
}

function requireV2(manifest, operation) {
  if (classifyManifest(manifest) !== "v2") {
    throw new ControlError("MANIFEST_NOT_V2", `${operation} require Manifest v2. Create a profile first to migrate this manifest safely.`, { status: 409 });
  }
}

function requireProfile(manifest, profileId) {
  if (!Object.hasOwn(manifest.profiles ?? {}, profileId)) {
    throw new ControlError("PROFILE_NOT_FOUND", `Unknown ContextCake profile: ${profileId}`, { status: 404 });
  }
}

function canonicalProjectPath(value) {
  const absolute = path.resolve(value);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch (error) {
    if (error.code === "ENOENT") throw new ControlError("NOT_FOUND", `Project folder does not exist: ${absolute}`, { status: 404 });
    throw error;
  }
  if (!stat.isDirectory()) throw usage(`Project mapping must name a directory: ${absolute}`);
  return fs.realpathSync.native(absolute);
}

export function currentProfile({ manifestPath, manifest = null, profile = null, cwd = process.cwd() }) {
  const source = manifest ?? readManifest(manifestPath);
  const selected = guard(() => selectManifestProfile(source, { requestedProfile: profile ?? null, cwd }));
  return {
    id: selected.profileId,
    label: selected.profileLabel,
    reason: selected.reason,
    mode: selected.mode,
    sourceCount: selected.layers.length,
    ...(selected.matchedProjectRoot ? { matchedProjectRoot: selected.matchedProjectRoot } : {}),
    ...(selected.warnings.length ? { warnings: selected.warnings } : {}),
  };
}

export function listProfiles({ manifestPath, manifest = null }) {
  const source = manifest ?? readManifest(manifestPath);
  return guard(() => listManifestProfiles(source));
}

export function createProfile({ manifestPath, label: requested, project = null, expectRevision = null }) {
  const profileLabel = label(requested);
  const projectPath = project ? path.resolve(project) : null;
  if (projectPath) canonicalProjectPath(projectPath);
  // The id is allocated inside migrateManifestToV2's lock, never from a read
  // taken before it.
  const result = guard(() => migrateManifestToV2(manifestPath, {
    newProfile: { label: profileLabel, layers: [] },
    projectPath,
    precondition: revisionPrecondition(expectRevision),
  }));
  return withRevision({
    created: result.profileId,
    label: profileLabel,
    action: result.action,
    ...(projectPath ? { project: fs.realpathSync.native(projectPath) } : {}),
    ...(result.backupPath ? { backupPath: result.backupPath, backupHash: result.backupHash } : {}),
  }, result.revision);
}

export function mapProject({ manifestPath, profileId, projectPath, expectRevision = null }) {
  if (!profileId || !projectPath) throw usage("Usage: profile map <id> <path> --manifest <file>");
  const canonical = canonicalProjectPath(projectPath);
  const [, revision] = mutate(manifestPath, (manifest) => {
    requireV2(manifest, "Project mappings");
    requireProfile(manifest, profileId);
    manifest.projects ??= {};
    for (const [configuredRoot, configuredProfile] of Object.entries(manifest.projects)) {
      let existingCanonical;
      try { existingCanonical = fs.realpathSync.native(configuredRoot); } catch { continue; }
      if (existingCanonical !== canonical) continue;
      if (configuredProfile !== profileId) {
        throw new ControlError("PROJECT_MAPPED", `Project mapping already belongs to profile ${configuredProfile}: ${configuredRoot}`, { status: 409 });
      }
      delete manifest.projects[configuredRoot];
    }
    manifest.projects[canonical] = profileId;
  }, expectRevision);
  return withRevision({ mapped: canonical, profileId }, revision);
}

export function unmapProject({ manifestPath, projectPath, expectRevision = null }) {
  if (!projectPath) throw usage("Usage: profile unmap <path> --manifest <file>");
  const absolute = path.resolve(projectPath);
  let canonical = null;
  try { canonical = fs.realpathSync.native(absolute); } catch { /* stale mapping can still be removed by exact path */ }
  let removed = null;
  const [, revision] = mutate(manifestPath, (manifest) => {
    requireV2(manifest, "Project mappings");
    for (const configuredRoot of Object.keys(manifest.projects ?? {})) {
      let matches = path.normalize(configuredRoot) === path.normalize(absolute);
      if (!matches && canonical) {
        try { matches = fs.realpathSync.native(configuredRoot) === canonical; } catch { /* stale */ }
      }
      if (!matches) continue;
      removed = configuredRoot;
      delete manifest.projects[configuredRoot];
      break;
    }
    if (!removed) throw new ControlError("MAPPING_NOT_FOUND", `No project mapping for: ${absolute}`, { status: 404 });
  }, expectRevision);
  return withRevision({ unmapped: removed }, revision);
}

function deletionPreview(manifest, profileId) {
  const mappings = Object.keys(manifest.projects ?? {}).filter((root) => manifest.projects[root] === profileId);
  const packAssignments = [];
  for (const [packId, record] of Object.entries(manifest.packs ?? {})) {
    if ((record.assignments ?? []).some((assignment) => assignment.profile === profileId)) packAssignments.push(packId);
  }
  return { profileId, mappings, packAssignments, sourceCount: manifest.profiles[profileId].layers.length };
}

// Without `confirm` this only previews; the adapter decides how a preview
// exits. With it, the manifest is written first and the profile's sidecar
// state is retired (renamed, never deleted) afterwards, still under the lock.
// That order means a crash or a failed rename can only ever leave state behind
// for a profile that is gone, which purge-state finds; it can never leave a
// live profile with its state moved away. A failed retire is reported as
// `stateNotRetired`, not thrown: the deletion itself succeeded.
export function deleteProfile({ manifestPath, profileId, confirm = false, expectRevision = null, now = new Date() }) {
  if (!profileId) throw usage("Usage: profile delete <id> --manifest <file> [--confirm]");
  if (profileId === "default") throw new ControlError("PROFILE_PROTECTED", "The default profile cannot be deleted.", { status: 409 });
  const manifest = readManifest(manifestPath);
  requireV2(manifest, "Profile deletion");
  requireProfile(manifest, profileId);
  const preview = deletionPreview(manifest, profileId);
  if (!confirm) return { ...preview, deleted: false, confirmationRequired: true };
  const precondition = revisionPrecondition(expectRevision);
  const outcome = guard(() => withManifestLock(path.resolve(manifestPath), () => {
    const candidate = readContextManifest(manifestPath, { allowMissing: false });
    precondition?.(candidate);
    requireV2(candidate, "Profile deletion");
    requireProfile(candidate, profileId);
    delete candidate.profiles[profileId];
    for (const [root, assignedProfile] of Object.entries(candidate.projects ?? {})) {
      if (assignedProfile === profileId) delete candidate.projects[root];
    }
    for (const record of Object.values(candidate.packs ?? {})) {
      record.assignments = (record.assignments ?? []).filter((assignment) => assignment.profile !== profileId);
    }
    writeContextManifest(manifestPath, candidate);
    const revision = manifestRevision(candidate);
    try {
      return { revision, retiredState: retireSidecarDir(manifestPath, profileId, { now }) };
    } catch (error) {
      return { revision, stateNotRetired: `${error.code ?? "ERROR"}: ${error.message}` };
    }
  }));
  return withRevision({
    ...preview,
    deleted: true,
    ...(outcome.retiredState ? { retiredState: outcome.retiredState } : {}),
    ...(outcome.stateNotRetired ? { stateNotRetired: outcome.stateNotRetired } : {}),
  }, outcome.revision);
}

export function showProfile({ manifestPath, manifest = null, profile = null, cwd = process.cwd() }) {
  const source = manifest ?? readManifest(manifestPath);
  const selected = guard(() => selectManifestProfile(source, { requestedProfile: profile ?? null, cwd }));
  const mode = selected.mode;
  const record = mode === "v2" ? source.profiles[selected.profileId] : null;
  const pending = mode === "v2" ? (record.pendingSources ?? []) : (source.pendingSources ?? []);
  const projects = mode === "v2"
    ? Object.keys(source.projects ?? {}).filter((root) => source.projects[root] === selected.profileId).sort()
    : [];
  const packs = Object.entries(source.packs ?? {})
    .flatMap(([packId, entry]) => (entry.assignments ?? [])
      .filter((assignment) => (assignment.profile ?? "default") === selected.profileId)
      .map((assignment) => ({ packId, layerName: assignment.layerName, version: assignment.activeVersion, level: Number(assignment.level) })));
  const stateDir = sidecarDir(manifestPath, selected.profileId);
  return {
    id: selected.profileId,
    label: selected.profileLabel,
    reason: selected.reason,
    mode,
    ...(selected.matchedProjectRoot ? { matchedProjectRoot: selected.matchedProjectRoot } : {}),
    sources: selected.layers.map((layer) => ({
      name: layer.name,
      kind: layer.source ?? "okf-local",
      level: Number(layer.level),
      ...(layer.live === true ? { live: true } : {}),
    })),
    pendingSources: pending.map((entry) => ({ name: entry.name, kind: typeof entry.source === "string" ? entry.source : "okf-local" })),
    projects,
    packs,
    state: { dir: stateDir, exists: fs.existsSync(stateDir) },
    ...(selected.warnings.length ? { warnings: selected.warnings } : {}),
  };
}

export function renameProfile({ manifestPath, profileId, label: requested, expectRevision = null }) {
  if (!profileId) throw usage("Usage: profile rename <id> <label>");
  const next = label(requested);
  let previous = null;
  const [, revision] = mutate(manifestPath, (manifest) => {
    requireV2(manifest, "Profile rename");
    requireProfile(manifest, profileId);
    const profile = manifest.profiles[profileId];
    previous = profile.label ?? (profileId === "default" ? "Default" : profileId);
    profile.label = next;
  }, expectRevision);
  return withRevision({ id: profileId, label: next, previousLabel: previous }, revision);
}

// A clone copies configuration: runnable sources, pending sources, and Pack
// assignments (a Pack layer without its assignment fails strict validation).
// It never copies project mappings (one folder maps to one profile) or sidecar
// state (decisions belong to the profile that made them). Executable MCP
// sources arrive pending, with command and args scrubbed, so the copy cannot
// run anything until someone configures it on this machine again.
export function cloneProfile({ manifestPath, profileId, label: requested, expectRevision = null }) {
  if (!profileId) throw usage("Usage: profile clone <id> <label>");
  const cloneLabel = label(requested);
  let created = null;
  let copied = 0;
  const pendingExecutables = [];
  const [, revision] = mutate(manifestPath, (manifest) => {
    requireV2(manifest, "Profile clone");
    requireProfile(manifest, profileId);
    const source = manifest.profiles[profileId];
    created = createProfileId(cloneLabel, Object.keys(manifest.profiles));
    const layers = [];
    const pendingSources = structuredClone(source.pendingSources ?? []);
    for (const layer of source.layers) {
      if ((layer.source ?? "okf-local") === "mcp") {
        const pending = structuredClone(layer);
        pending.command = { ...EXECUTION_SCRUBBED };
        if (Object.hasOwn(pending, "args")) pending.args = { ...EXECUTION_SCRUBBED };
        pendingSources.push(pending);
        pendingExecutables.push(layer.name);
      } else {
        layers.push(structuredClone(layer));
        copied += 1;
      }
    }
    manifest.profiles[created] = {
      label: cloneLabel,
      layers,
      ...(pendingSources.length ? { pendingSources } : {}),
    };
    for (const record of Object.values(manifest.packs ?? {})) {
      const assignment = (record.assignments ?? []).find((entry) => (entry.profile ?? "default") === profileId);
      if (!assignment || !layers.some((layer) => layer.name === assignment.layerName)) continue;
      record.assignments.push({ ...structuredClone(assignment), profile: created });
    }
  }, expectRevision);
  return withRevision({ created, label: cloneLabel, from: profileId, sourceCount: copied, pendingExecutables }, revision);
}

// The destructive step after `delete`: removes state no profile owns. The
// ownership check and the deletion share the manifest lock, so a profile
// re-created with the same id cannot lose its new state in between.
export function purgeProfileState({ manifestPath, profileId, confirm = false }) {
  if (!profileId) throw usage("Usage: profile purge-state <id> --confirm");
  try {
    sidecarDir(manifestPath, profileId);
  } catch {
    throw usage(`Invalid ContextCake profile id: ${profileId}`);
  }
  return guard(() => withManifestLock(path.resolve(manifestPath), () => {
    const manifest = readContextManifest(manifestPath, { allowMissing: false, validatePacks: false });
    if (profileId === "default" || Object.hasOwn(manifest.profiles ?? {}, profileId)) {
      throw new ControlError("PROFILE_ACTIVE", `Profile ${profileId} still exists. Delete it first; purge-state only removes state no profile owns.`, { status: 409 });
    }
    const dirs = listStaleSidecarDirs(manifestPath, profileId);
    if (!confirm) return { profileId, dirs, purged: false, confirmationRequired: dirs.length > 0 };
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    return { profileId, dirs, purged: true };
  }));
}

// Human text for the adapters. Kept beside the operations so the dispatcher
// and profile-cli.mjs print the same lines.
export const PROFILE_TEXT = {
  current: (result) => `${result.label} (${result.id}) — ${result.reason}${result.matchedProjectRoot ? `\nProject: ${result.matchedProjectRoot}` : ""}`,
  list: (profiles) => profiles.map((profile) => (
    `${profile.id}\t${profile.label}\t${profile.sourceCount} source${profile.sourceCount === 1 ? "" : "s"}`
      + `\t${profile.mappingCount} mapping${profile.mappingCount === 1 ? "" : "s"}`
      + `${profile.valid ? "" : "\tneeds repair"}`
  )).join("\n"),
  create: (response) => `Created ${response.label} (${response.created})${response.project ? `\nMapped ${response.project}` : ""}${response.backupPath ? `\nBackup: ${response.backupPath}` : ""}`,
  map: (result) => `Mapped ${result.mapped} -> ${result.profileId}`,
  unmap: (result) => `Removed mapping ${result.unmapped}`,
  deletePreview: (preview) => `Delete ${preview.profileId}? ${preview.mappings.length} project mapping(s), ${preview.packAssignments.length} Pack assignment(s), and the profile reference will be removed.\nUnderlying source, Pack, overlay, cache, and live-repository files will remain.\nRe-run with --confirm.`,
  deleted: (result) => `Deleted profile ${result.profileId}. Underlying files were not removed.`
    + `${result.retiredState ? `\nProfile state retired to ${result.retiredState}` : ""}`
    + `${result.stateNotRetired ? `\nProfile state was not retired (${result.stateNotRetired}); 'profile purge-state ${result.profileId}' can still remove it.` : ""}`,
};
