// Shared ContextCake manifest boundary.
//
// This module owns schema-mode detection, profile selection, migration, and
// serialized atomic writes. Callers may inspect a complete manifest here, but
// runtime adapters should receive only the selected layer array returned by
// selectManifestProfile(). The dependency-free core deliberately uses only
// Node.js built-ins.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MANIFEST_LOCK_TIMEOUT_MS = 15_000;
export const MANIFEST_LOCK_STALE_MS = 60_000;

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const RUNNABLE_SOURCE_KINDS = new Set(["okf-local", "files", "github", "mcp"]);
const CREDENTIAL_PATTERN = /(?:github_pat_|gh[pousr]_|sk-[A-Za-z0-9]|bearer\s+[A-Za-z0-9._-])/i;
const CREDENTIAL_KEY_PATTERN = /^(?:(?:[a-z0-9]+_)?token|access[_-]?token|refresh[_-]?token|password|passwd|secret|client[_-]?secret|private[_-]?key|api[_-]?key|credential|authorization|cookie)$/i;
const CREDENTIAL_VALUE_PATTERN = /(?:github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|glpat-[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{12,}|bearer\s+[A-Za-z0-9._-]{12,}|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|https?:\/\/[^/@\s]+:[^/@\s]+@)/i;
const CREDENTIAL_ASSIGNMENT_PATTERN = /(?:^|[\s?&#:_'"-])(?:access[_-]?token|token|api[_-]?key|client[_-]?secret|private[_-]?key|secret|password|credential|authorization|signature|sig)\s*(?:=|:)/i;

export function classifyManifest(manifest) {
  assertObject(manifest, "ContextCake manifest");
  const hasLayers = Object.hasOwn(manifest, "layers");
  const hasProfiles = Object.hasOwn(manifest, "profiles");
  if (hasLayers && hasProfiles) return "transitional";
  if (hasProfiles) return "v2";
  return "legacy";
}

export function validateContextManifest(manifest, { validatePacks = true } = {}) {
  assertSafeKeys(manifest);
  rejectCredentialFields(manifest, "ContextCake manifest");
  rejectCredentialValues(manifest, "ContextCake manifest", { allowScrubbed: true });
  const mode = classifyManifest(manifest);
  const warnings = [];

  if (mode === "legacy" || mode === "transitional") {
    if (manifest.layers !== undefined && !Array.isArray(manifest.layers)) throw new Error("ContextCake manifest layers must be an array.");
    validateLayers(manifest.layers ?? [], "legacy default");
  }

  if (mode === "v2" || mode === "transitional") {
    assertObject(manifest.profiles, "ContextCake manifest profiles");
    if (mode === "v2" && !Object.hasOwn(manifest.profiles, "default")) {
      throw new Error("Manifest v2 requires profiles.default.");
    }
    for (const [profileId, profile] of Object.entries(manifest.profiles)) {
      assertProfileId(profileId);
      assertObject(profile, `Profile ${profileId}`);
      if (profile.label !== undefined) normalizeProfileLabel(profile.label);
      if (!Array.isArray(profile.layers)) throw new Error(`Profile ${profileId} does not have a layers array.`);
      if (mode === "transitional") {
        validateTransitionalProfileLayers(profile.layers, `profile ${profileId}`);
        for (const layer of profile.layers) {
          if (!isRunnableLayer(layer)) warnings.push({ code: "pending-source", profileId, sourceName: layer.name });
        }
      } else validateLayers(profile.layers, `profile ${profileId}`);
      if (profile.pendingSources !== undefined) {
        if (!Array.isArray(profile.pendingSources)) throw new Error(`Profile ${profileId} pendingSources must be an array.`);
        validatePendingSources(profile.pendingSources, `profile ${profileId}`);
        for (const source of profile.pendingSources) warnings.push({ code: "pending-source", profileId, sourceName: source.name });
      }
    }
  }

  if (manifest.pendingSources !== undefined) {
    if (!Array.isArray(manifest.pendingSources)) throw new Error("ContextCake manifest pendingSources must be an array.");
    validatePendingSources(manifest.pendingSources, "legacy default");
    for (const source of manifest.pendingSources) warnings.push({ code: "pending-source", profileId: "default", sourceName: source.name });
  }

  if (manifest.projects !== undefined) {
    assertObject(manifest.projects, "ContextCake manifest projects");
    for (const [root, profileId] of Object.entries(manifest.projects)) {
      if (!path.isAbsolute(root)) throw new Error(`Project mapping must use an absolute path: ${root}`);
      assertProfileId(profileId);
      if (mode !== "v2" || !Object.hasOwn(manifest.profiles, profileId)) {
        warnings.push({ code: "dangling-project-profile", root, profileId });
      }
    }
  }

  if (validatePacks) validatePackRegistry(manifest, mode, warnings);
  return { mode, warnings };
}

export function readContextManifest(manifestPath, { allowMissing = true, validatePacks = true } = {}) {
  const resolved = path.resolve(manifestPath);
  if (!fs.existsSync(resolved)) {
    if (allowMissing) return { layers: [] };
    throw new Error(`ContextCake manifest does not exist: ${resolved}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`ContextCake manifest is not valid JSON: ${error.message}`);
  }
  validateContextManifest(manifest, { validatePacks });
  return manifest;
}

/**
 * The manifest as the READ path may use it. Whole-manifest rules stay fatal,
 * but a layer that fails validation is lifted out instead of taking every
 * route down with it: one hand-edited layer used to make /api/settings and
 * /api/graph answer 500, including the screen a user would need to fix it.
 *
 * Quarantine only ever REMOVES capability. A layer that fails validation is
 * deleted from the manifest this returns, so nothing downstream can build it,
 * spawn it, watch its root, or hand its path to the file APIs — it survives
 * only as a {name, level, error} record for the UI to show as a broken row.
 * No validation rule is relaxed and nothing is coerced into working. And this
 * is a read-path tolerance alone: writeContextManifest/mutateContextManifest
 * still validate the whole manifest strictly, so an invalid layer can never be
 * persisted through a quarantined read.
 *
 * Returns { manifest, quarantined }, where each quarantined record carries the
 * `profileId` of the layers array it came from — "default" is always the array
 * getManifestProfileLayers(manifest) itself would return.
 */
export function readContextManifestQuarantined(manifestPath, { allowMissing = true, validatePacks = true } = {}) {
  const resolved = path.resolve(manifestPath);
  if (!fs.existsSync(resolved)) {
    if (allowMissing) return { manifest: { layers: [] }, quarantined: [] };
    throw new Error(`ContextCake manifest does not exist: ${resolved}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`ContextCake manifest is not valid JSON: ${error.message}`);
  }
  // The strict pass runs first and unchanged, so a valid manifest takes exactly
  // the path it always did and returns the very object readContextManifest
  // would have. Partitioning is reached only once something has already failed.
  let firstError;
  try {
    validateContextManifest(manifest, { validatePacks });
    return { manifest, quarantined: [] };
  } catch (error) {
    firstError = error;
  }
  let cleaned;
  let quarantined;
  try {
    ({ manifest: cleaned, quarantined } = quarantineInvalidLayers(manifest));
  } catch {
    // Partitioning is a recovery attempt, so when it cannot even run — a
    // manifest that is not an object, a `layers` that is not an array — the
    // caller gets the authoritative validation error, not a second-hand one.
    throw firstError;
  }
  if (quarantined.length === 0) throw firstError;
  // If dropping the bad layers did not make the rest valid, the failure was
  // never per-layer (a broken profiles block, a dangling pack). Fail closed
  // exactly as before rather than serving a manifest nobody has validated.
  validateContextManifest(cleaned, { validatePacks });
  return { manifest: cleaned, quarantined };
}

// Splits every layers array in the manifest into the layers that validate and
// the ones that do not, returning a copy that holds only the former. Pure: the
// caller's manifest object is never mutated.
function quarantineInvalidLayers(manifest) {
  // Reserved keys are checked here, before anything is copied, so the two read
  // paths cannot disagree about them. Rebuilding profiles with plain assignment
  // meant a profile literally named __proto__ set the prototype of the new
  // container instead of becoming an own key: Object.entries no longer saw it,
  // the re-validation below passed, and the quarantined read accepted a
  // manifest the strict read rejects. Throwing lands the caller on `firstError`
  // — the authoritative strict message — which is exactly what parity means.
  assertSafeKeys(manifest);
  const mode = classifyManifest(manifest); // throws on a non-object manifest, as before
  const cleaned = { ...manifest };
  const quarantined = [];

  const partition = (profileId, layers, owner, transitional) => {
    if (!Array.isArray(layers)) throw new Error(`${owner} does not have a layers array.`);
    const { kept, dropped } = partitionLayers(layers, owner, transitional);
    for (const record of dropped) quarantined.push({ profileId, ...record });
    return kept;
  };

  // The container profile=null resolves to is the one keyed "default": the
  // top-level array in legacy and transitional manifests, profiles.default in
  // v2. Mirrors getManifestProfileLayers so a caller can line the two up.
  if (mode === "legacy" || mode === "transitional") {
    cleaned.layers = partition("default", manifest.layers ?? [], "legacy default", false);
  }
  if (mode === "v2" || mode === "transitional") {
    assertObject(manifest.profiles, "ContextCake manifest profiles");
    // defineProperty rather than assignment: a reserved id can never reach here
    // (assertSafeKeys above), and this is what keeps that true if it ever does
    // — every id lands as an own key, so nothing can be smuggled past the
    // Object.entries re-validation by way of the prototype.
    const profiles = {};
    for (const [id, profile] of Object.entries(manifest.profiles)) {
      assertObject(profile, `Profile ${id}`);
      const profileId = mode === "v2" ? id : `profiles.${id}`;
      Object.defineProperty(profiles, id, {
        value: { ...profile, layers: partition(profileId, profile.layers, `profile ${id}`, mode === "transitional") },
        writable: true, enumerable: true, configurable: true,
      });
    }
    cleaned.profiles = profiles;
  }
  return { manifest: cleaned, quarantined };
}

// Only a layer that is malformed ON ITS OWN is quarantined. The rules about how
// layers relate — a duplicated name, a second live layer — deliberately stay
// fatal: those manifests are ambiguous rather than broken, and quarantining one
// of the pair would mean silently picking which of two well-formed layers wins.
// Failing closed on ambiguity is the safer half of that choice, and it is what
// today already does. The caller re-validates what survives, so those errors
// still reach it.
function partitionLayers(layers, owner, transitional) {
  const kept = [];
  const dropped = [];
  const names = new Set();
  layers.forEach((layer, index) => {
    try {
      if (transitional) validateTransitionalLayer(layer, owner);
      else validateLayer(layer, owner);
    } catch (error) {
      dropped.push({ layer, index, error: error.message });
      return;
    }
    names.add(layer.name);
    kept.push(layer);
  });
  // Named after the fact, against the names that survived, so a layer too
  // malformed to have a usable name still gets a row of its own and can never
  // shadow a healthy source's row in the graph.
  const taken = new Set(names);
  return {
    kept,
    dropped: dropped.map(({ layer, index, error }) => {
      const base = typeof layer?.name === "string" && layer.name.trim() ? layer.name.trim() : `layer ${index + 1}`;
      let name = base;
      for (let n = 2; taken.has(name); n += 1) name = `${base} (${n})`;
      taken.add(name);
      return {
        name,
        level: Number.isInteger(Number(layer?.level)) ? Number(layer.level) : 0,
        // The declared kind, as a scalar. The layer OBJECT deliberately never
        // leaves this module — that is what makes it structurally impossible to
        // build or persist — but a row that reports the kind the user actually
        // typed beats one silently labelled with the default.
        kind: typeof layer?.source === "string" ? layer.source : "okf-local",
        error,
      };
    }),
  };
}

export function getManifestProfileLayers(manifest, profile = null) {
  const { mode } = validateContextManifest(manifest);
  if (mode === "legacy") {
    if (profile !== null && profile !== "default") throw new Error(`Unknown ContextCake profile: ${profile}`);
    manifest.layers ??= [];
    return manifest.layers;
  }
  if (mode === "transitional") {
    if (profile === null || profile === "default") return manifest.layers;
    if (!Object.hasOwn(manifest.profiles, profile)) throw new Error(`Unknown ContextCake profile: ${profile}`);
    return manifest.profiles[profile].layers;
  }
  const profileId = profile ?? "default";
  if (!Object.hasOwn(manifest.profiles, profileId)) throw new Error(`Unknown ContextCake profile: ${profileId}`);
  return manifest.profiles[profileId].layers;
}

export function selectManifestProfile(manifest, {
  requestedProfile = null,
  cwd = process.cwd(),
  realpath = fs.realpathSync.native,
} = {}) {
  const { mode, warnings } = validateContextManifest(manifest, { validatePacks: false });
  if (mode === "legacy" || mode === "transitional") {
    if (requestedProfile !== null && requestedProfile !== "default") {
      throw new Error(`Profile ${requestedProfile} requires migration to Manifest v2.`);
    }
    validatePackRegistry(manifest, mode, warnings, { strict: false, selectedProfile: "default" });
    return {
      mode,
      profileId: "default",
      profileLabel: "Default",
      layers: manifest.layers ?? [],
      reason: requestedProfile === "default" ? "explicit" : "legacy-default",
      matchedProjectRoot: null,
      warnings,
    };
  }

  if (requestedProfile !== null) {
    assertProfileId(requestedProfile);
    return selectedV2Profile(manifest, requestedProfile, "explicit", null, warnings);
  }

  const canonicalCwd = canonicalExistingPath(cwd, realpath, "Working directory");
  const matches = [];
  for (const [configuredRoot, profileId] of Object.entries(manifest.projects ?? {})) {
    let canonicalRoot;
    try {
      canonicalRoot = canonicalExistingPath(configuredRoot, realpath, "Project mapping");
    } catch {
      warnings.push({ code: "stale-project-root", root: configuredRoot, profileId });
      continue;
    }
    if (!containsPath(canonicalRoot, canonicalCwd)) continue;
    matches.push({ configuredRoot, canonicalRoot, profileId, depth: pathDepth(canonicalRoot) });
  }
  matches.sort((a, b) => b.depth - a.depth || b.canonicalRoot.length - a.canonicalRoot.length);
  if (matches.length) {
    const winner = matches[0];
    const conflict = matches.find((candidate) => (
      candidate !== winner
      && candidate.depth === winner.depth
      && candidate.canonicalRoot === winner.canonicalRoot
      && candidate.profileId !== winner.profileId
    ));
    if (conflict) throw new Error(`Project mappings resolve the same canonical root to different profiles: ${winner.configuredRoot} and ${conflict.configuredRoot}`);
    return selectedV2Profile(manifest, winner.profileId, "project", winner.canonicalRoot, warnings);
  }
  return selectedV2Profile(manifest, "default", "default", null, warnings);
}

export function listManifestProfiles(manifest) {
  const { mode, warnings } = validateContextManifest(manifest, { validatePacks: false });
  validatePackRegistry(manifest, mode, warnings, { strict: false });
  if (mode === "legacy") {
    return [{ id: "default", label: "Default", sourceCount: manifest.layers?.length ?? 0, mappingCount: 0, mode, valid: true }];
  }
  if (mode === "transitional") {
    const virtual = [{ id: "default", label: "Default", sourceCount: manifest.layers.length, mappingCount: 0, mode, valid: true }];
    return virtual.concat(Object.entries(manifest.profiles)
      .filter(([id]) => id !== "default")
      .map(([id, profile]) => profileSummary(id, profile, manifest.projects, mode, warnings)));
  }
  return Object.entries(manifest.profiles).map(([id, profile]) => profileSummary(id, profile, manifest.projects, mode, warnings));
}

export function normalizeProfileLabel(value) {
  if (typeof value !== "string") throw new Error("Profile label must be a string.");
  const label = value.normalize("NFC").trim();
  if (label.length < 1 || [...label].length > 80) throw new Error("Profile label must contain 1 to 80 characters.");
  if (/\p{Cc}|\p{Cf}/u.test(label) || /[\r\n]/.test(label)) throw new Error("Profile label cannot contain control characters or line breaks.");
  if (CREDENTIAL_PATTERN.test(label)) throw new Error("Profile label looks like a credential and was rejected.");
  return label;
}

export function createProfileId(label, existingIds = []) {
  const normalized = normalizeProfileLabel(label)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "") || "profile";
  const occupied = new Set(existingIds);
  if (!occupied.has(normalized)) return normalized;
  for (let suffix = 2; suffix < 1_000_000; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${normalized.slice(0, 63 - tail.length).replace(/-+$/g, "")}${tail}`;
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error("Could not allocate a unique profile id.");
}

export function manifestRevision(manifest) {
  return crypto.createHash("sha256").update(stableJson(manifest)).digest("hex");
}

export function sourceConfigFingerprint(profileId, layer, manifestDir = process.cwd()) {
  assertProfileId(profileId);
  validateLayer(layer, `profile ${profileId}`);
  const kind = layer.source ?? "okf-local";
  const localRoot = (kind === "okf-local" || kind === "files") && typeof layer.path === "string"
    ? canonicalConfiguredPath(manifestDir, layer.path)
    : null;
  const mcpArgs = kind === "mcp"
    ? (layer.args ?? []).map((argument) => (
      argument.startsWith("./") || argument.startsWith("../")
        ? canonicalConfiguredPath(manifestDir, argument)
        : argument
    ))
    : null;
  const config = {
    profileId,
    name: layer.name,
    kind,
    root: localRoot,
    repo: layer.repo ?? null,
    ref: layer.ref ?? null,
    paths: layer.paths ?? null,
    apiBase: layer.apiBase ?? null,
    auth: layer.auth ?? null,
    command: kind === "mcp" ? layer.command ?? null : null,
    args: mcpArgs,
    cache: layer.cache ? { ttlSeconds: layer.cache.ttlSeconds ?? null } : null,
    git: layer.git ?? null,
  };
  return crypto.createHash("sha256").update(stableJson(config)).digest("hex");
}

export function writeContextManifest(manifestPath, manifest, {
  allowLegacy = true,
  allowTransitional = false,
} = {}) {
  const { mode } = validateContextManifest(manifest);
  if (mode === "legacy" && !allowLegacy) throw new Error("A legacy manifest cannot be written by this operation.");
  if (mode === "transitional" && !allowTransitional) {
    throw new Error("A transitional manifest can only be written by an explicit compatibility operation or normalized to v2.");
  }
  writeAtomicJson(path.resolve(manifestPath), manifest);
}

export function withManifestLock(manifestPath, mutate, {
  timeoutMs = MANIFEST_LOCK_TIMEOUT_MS,
  staleMs = MANIFEST_LOCK_STALE_MS,
} = {}) {
  const resolved = path.resolve(manifestPath);
  const lockPath = `${resolved}.lock`;
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  let token = tryAcquireManifestLock(lockPath, staleMs);
  while (token === null) {
    if (Date.now() >= deadline) throw new Error(`Timed out acquiring the ContextCake manifest lock at ${lockPath}.`);
    sleepSync(50);
    token = tryAcquireManifestLock(lockPath, staleMs);
  }
  try {
    return mutate();
  } finally {
    releaseManifestLock(lockPath, token);
  }
}

// Async counterpart for profile-bound runtime writes. Holding the same lock
// across revalidation and the resulting filesystem/git mutation closes the
// race where a concurrent profile edit could retarget a write after the check.
export async function withManifestLockAsync(manifestPath, mutate, {
  timeoutMs = MANIFEST_LOCK_TIMEOUT_MS,
  staleMs = MANIFEST_LOCK_STALE_MS,
} = {}) {
  const resolved = path.resolve(manifestPath);
  const lockPath = `${resolved}.lock`;
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  let token = tryAcquireManifestLock(lockPath, staleMs);
  while (token === null) {
    if (Date.now() >= deadline) throw new Error(`Timed out acquiring the ContextCake manifest lock at ${lockPath}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    token = tryAcquireManifestLock(lockPath, staleMs);
  }
  try {
    return await mutate();
  } finally {
    releaseManifestLock(lockPath, token);
  }
}

export function mutateContextManifest(manifestPath, mutate, {
  allowMissing = true,
  allowLegacy = true,
  allowTransitional = false,
} = {}) {
  const resolved = path.resolve(manifestPath);
  return withManifestLock(resolved, () => {
    const manifest = readContextManifest(resolved, { allowMissing });
    const result = mutate(manifest);
    writeContextManifest(resolved, manifest, { allowLegacy, allowTransitional });
    return result;
  });
}

export function migrateManifestToV2(manifestPath, {
  newProfile = null,
  projectPath = null,
  now = () => new Date(),
  realpath = fs.realpathSync.native,
} = {}) {
  const resolved = path.resolve(manifestPath);
  return withManifestLock(resolved, () => {
    const raw = fs.readFileSync(resolved);
    const manifest = readContextManifest(resolved, { allowMissing: false });
    const beforeMode = classifyManifest(manifest);
    if (newProfile) validateNewProfile(newProfile, manifest);

    if (beforeMode === "v2") {
      const candidate = structuredClone(manifest);
      applyNewProfile(candidate, newProfile, projectPath, realpath);
      if (newProfile) writeContextManifest(resolved, candidate, { allowLegacy: false });
      return { action: newProfile ? "profile-created" : "already-v2", mode: "v2", backupPath: null, backupHash: null };
    }

    const candidate = normalizeToV2(manifest);
    applyNewProfile(candidate, newProfile, projectPath, realpath);
    validateContextManifest(candidate);

    const backupHash = crypto.createHash("sha256").update(raw).digest("hex");
    const stamp = formatUtcTimestamp(now());
    const backupPath = `${resolved}.pre-profiles.${stamp}.${backupHash}.json`;
    writeVerifiedBackup(backupPath, raw, backupHash);
    writeContextManifest(resolved, candidate, { allowLegacy: false });
    return { action: "migrated", mode: "v2", backupPath, backupHash };
  });
}

export function verifyManifestBackup(backupPath, expectedHash) {
  if (!/^([a-f0-9]{64})$/.test(expectedHash)) throw new Error("Expected backup hash must be a SHA-256 hex digest.");
  const actual = crypto.createHash("sha256").update(fs.readFileSync(backupPath)).digest("hex");
  if (actual !== expectedHash) throw new Error(`Manifest backup hash mismatch: expected ${expectedHash}, received ${actual}.`);
  return true;
}

function selectedV2Profile(manifest, profileId, reason, matchedProjectRoot, warnings) {
  if (!Object.hasOwn(manifest.profiles, profileId)) throw new Error(`Unknown ContextCake profile: ${profileId}`);
  validatePackRegistry(manifest, "v2", warnings, { strict: false, selectedProfile: profileId });
  const profile = manifest.profiles[profileId];
  return {
    mode: "v2",
    profileId,
    profileLabel: profile.label ?? (profileId === "default" ? "Default" : profileId),
    layers: profile.layers,
    reason,
    matchedProjectRoot,
    warnings,
  };
}

function profileSummary(id, profile, projects, mode, warnings) {
  return {
    id,
    label: profile.label ?? (id === "default" ? "Default" : id),
    sourceCount: profile.layers.length,
    pendingSourceCount: profile.pendingSources?.length ?? 0,
    mappingCount: Object.values(projects ?? {}).filter((profileId) => profileId === id).length,
    mode,
    valid: !warnings.some((warning) => warning.profileId === id && warning.code !== "pending-source"),
  };
}

function validateLayers(layers, owner) {
  const names = new Set();
  let liveCount = 0;
  for (const layer of layers) {
    validateLayer(layer, owner);
    if (names.has(layer.name)) throw new Error(`${owner} contains duplicate layer name: ${layer.name}`);
    names.add(layer.name);
    if (layer.live === true) liveCount += 1;
  }
  if (liveCount > 1) throw new Error(`${owner} contains more than one live layer.`);
}

function validateTransitionalProfileLayers(layers, owner) {
  const names = new Set();
  for (const layer of layers) {
    validateTransitionalLayer(layer, owner);
    if (names.has(layer.name)) throw new Error(`${owner} contains duplicate layer name: ${layer.name}`);
    names.add(layer.name);
  }
}

function validateTransitionalLayer(layer, owner) {
  assertObject(layer, `Layer in ${owner}`);
  rejectCredentialFields(layer, `Layer in ${owner}`);
  rejectCredentialValues(layer, `Layer in ${owner}`, { allowScrubbed: true });
  if (typeof layer.name !== "string" || !layer.name.trim()) throw new Error(`Layer in ${owner} must have a non-empty name.`);
  if (isRunnableLayer(layer)) validateLayer(layer, owner);
  else validateAuthReference(layer.auth, `Pending source ${layer.name}`, { allowScrubbed: true });
}

function validateLayer(layer, owner) {
  assertObject(layer, `Layer in ${owner}`);
  rejectCredentialFields(layer, `Layer in ${owner}`);
  rejectCredentialValues(layer, `Layer in ${owner}`);
  if (typeof layer.name !== "string" || !layer.name.trim()) throw new Error(`Layer in ${owner} must have a non-empty name.`);
  if (!Number.isInteger(Number(layer.level))) throw new Error(`Layer ${layer.name} in ${owner} must have an integer level.`);
  const kind = layer.source ?? "okf-local";
  if (!RUNNABLE_SOURCE_KINDS.has(kind)) throw new Error(`Layer ${layer.name} has unsupported source kind: ${kind}`);
  if ((kind === "okf-local" || kind === "files") && typeof layer.path !== "string") {
    throw new Error(`Layer ${layer.name} requires a path.`);
  }
  if (kind === "github" && typeof layer.repo !== "string") throw new Error(`Layer ${layer.name} requires a GitHub repo.`);
  if (kind === "github") validateApiBase(layer.apiBase, `Layer ${layer.name}`);
  if (kind === "mcp" && typeof layer.command !== "string") throw new Error(`Layer ${layer.name} requires an MCP command.`);
  if (layer.args !== undefined && (!Array.isArray(layer.args) || layer.args.some((value) => typeof value !== "string"))) {
    throw new Error(`Layer ${layer.name} args must be an array of strings.`);
  }
  validateAuthReference(layer.auth, `Layer ${layer.name}`);
}

// The GitHub Enterprise knob decides where a named credential gets SENT, so it
// is the other half of the auth contract: `auth` says which secret, `apiBase`
// says to whom. A manifest you did not author could otherwise aim a real token
// at a host of its choosing. This rejects the shapes that make that easy
// (http, embedded userinfo, a query that could smuggle a second target); the
// binding that actually withholds the secret from an unexpected host lives at
// injection time in sources/index.mjs. Validation is the first half of that
// control, never the whole of it.
export function validateApiBase(apiBase, label) {
  if (apiBase === undefined || apiBase === null) return;
  if (typeof apiBase !== "string" || !apiBase.trim()) {
    throw new Error(`${label} apiBase must be an https URL.`);
  }
  let url;
  try {
    url = new URL(apiBase);
  } catch {
    throw new Error(`${label} apiBase must be a valid https URL.`);
  }
  // Loopback over http is the one carve-out, on the same reasoning browsers use
  // for secure contexts: a host only reachable from this machine is not the
  // remote-exfiltration target this rule exists to stop, and it is what lets a
  // mock API prove the credentialed path end to end.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error(`${label} apiBase must use https (http only for loopback).`);
  }
  if (url.username || url.password) throw new Error(`${label} apiBase must not embed credentials.`);
  if (url.search || url.hash) throw new Error(`${label} apiBase must not carry a query or fragment.`);
}

// Accepts a hostname or a host:port, including bracketed IPv6.
export function isLoopbackHost(host) {
  const h = String(host ?? "").toLowerCase().replace(/:\d+$/, "");
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1" || h.endsWith(".localhost");
}

function validatePendingSources(sources, owner) {
  const names = new Set();
  for (const source of sources) {
    assertObject(source, `Pending source in ${owner}`);
    rejectCredentialFields(source, `Pending source in ${owner}`);
    rejectCredentialValues(source, `Pending source in ${owner}`, { allowScrubbed: true });
    if (typeof source.name !== "string" || !source.name.trim()) throw new Error(`Pending source in ${owner} must have a non-empty name.`);
    if (names.has(source.name)) throw new Error(`${owner} contains duplicate pending source name: ${source.name}`);
    names.add(source.name);
    validateAuthReference(source.auth, `Pending source ${source.name}`, { allowScrubbed: true });
  }
}

function validatePackRegistry(manifest, mode, warnings, { strict = true, selectedProfile = null } = {}) {
  if (manifest.packs === undefined) return;
  assertObject(manifest.packs, "ContextCake manifest packs registry");
  const assignedLayers = new Set();
  for (const [packId, record] of Object.entries(manifest.packs)) {
    assertObject(record, `Pack registry entry ${packId}`);
    if (record.id !== undefined && record.id !== packId) throw new Error(`Pack registry key ${packId} does not match record id ${record.id}.`);
    if (!Array.isArray(record.installedVersions) || !Array.isArray(record.assignments)) {
      throw new Error(`Pack registry entry is missing version or assignment arrays: ${packId}`);
    }
    const versions = new Set();
    for (const entry of record.installedVersions) {
      assertObject(entry, `Installed Pack version ${packId}`);
      if (typeof entry.version !== "string" || !entry.version) throw new Error(`Pack ${packId} has an invalid installed version.`);
      if (versions.has(entry.version)) throw new Error(`Pack ${packId} contains duplicate retained version ${entry.version}.`);
      versions.add(entry.version);
    }
    const assignmentProfiles = new Set();
    for (const assignment of record.assignments) {
      assertObject(assignment, `Pack assignment ${packId}`);
      const profileId = assignment.profile ?? null;
      if (profileId !== null) assertProfileId(profileId);
      if (typeof assignment.layerName !== "string" || !assignment.layerName) throw new Error(`Pack ${packId} assignment is missing layerName.`);
      if (typeof assignment.activeVersion !== "string" || !assignment.activeVersion) throw new Error(`Pack ${packId} assignment is missing activeVersion.`);
      if (!Number.isInteger(Number(assignment.level))) throw new Error(`Pack ${packId} assignment has an invalid level.`);
      const normalizedProfileId = mode === "v2" && profileId === null ? "default" : (profileId ?? "default");
      if (assignmentProfiles.has(normalizedProfileId)) throw new Error(`Pack ${packId} contains a duplicate assignment for profile ${normalizedProfileId}.`);
      assignmentProfiles.add(normalizedProfileId);
      if (mode === "v2" && profileId === null) warnings.push({ code: "legacy-null-pack-profile", packId, profileId: "default" });
      let layers;
      try {
        layers = getLayersWithoutValidation(manifest, mode, profileId);
      } catch (error) {
        reportPackInvariant(error.message, { code: "dangling-pack-profile", packId, profileId: normalizedProfileId }, warnings, { strict, selectedProfile });
        continue;
      }
      if (!versions.has(assignment.activeVersion)) {
        reportPackInvariant(
          `Pack ${packId} assignment references missing version ${assignment.activeVersion}.`,
          { code: "missing-pack-version", packId, profileId: normalizedProfileId },
          warnings,
          { strict, selectedProfile },
        );
        continue;
      }
      const matches = layers.filter((layer) => layer.name === assignment.layerName);
      if (matches.length !== 1) {
        reportPackInvariant(
          `Pack ${packId} assignment must match exactly one layer named ${assignment.layerName}.`,
          { code: "missing-pack-layer", packId, profileId: normalizedProfileId, layerName: assignment.layerName },
          warnings,
          { strict, selectedProfile },
        );
        continue;
      }
      const layer = matches[0];
      const expectedOrigin = `pack:${packId}@${assignment.activeVersion}`;
      if (layer.origin !== expectedOrigin || Number(layer.level) !== Number(assignment.level)) {
        reportPackInvariant(
          `Pack ${packId} assignment does not match layer ${assignment.layerName}.`,
          { code: "pack-layer-drift", packId, profileId: normalizedProfileId, layerName: assignment.layerName },
          warnings,
          { strict, selectedProfile },
        );
        continue;
      }
      assignedLayers.add(`${normalizedProfileId}\0${layer.name}\0${layer.origin}`);
    }
  }
  for (const [profileId, layers] of allRunnableLayerSets(manifest, mode)) {
    for (const layer of layers) {
      if (typeof layer.origin !== "string" || !layer.origin.startsWith("pack:")) continue;
      if (!assignedLayers.has(`${profileId}\0${layer.name}\0${layer.origin}`)) {
        reportPackInvariant(
          `Pack layer ${layer.name} in profile ${profileId} has no matching registry assignment.`,
          { code: "orphan-pack-layer", profileId, layerName: layer.name },
          warnings,
          { strict, selectedProfile },
        );
      }
    }
  }
}

function reportPackInvariant(message, details, warnings, { strict, selectedProfile }) {
  if (strict || (selectedProfile !== null && details.profileId === selectedProfile)) throw new Error(message);
  warnings.push({ ...details, message });
}

function getLayersWithoutValidation(manifest, mode, profile) {
  if (mode === "legacy") {
    if (profile !== null && profile !== "default") throw new Error(`Unknown ContextCake profile: ${profile}`);
    return manifest.layers ?? [];
  }
  if (mode === "transitional") {
    if (profile === null || profile === "default") return manifest.layers;
    if (!Object.hasOwn(manifest.profiles, profile)) throw new Error(`Unknown ContextCake profile: ${profile}`);
    return manifest.profiles[profile].layers;
  }
  const profileId = profile ?? "default";
  if (!Object.hasOwn(manifest.profiles, profileId)) throw new Error(`Unknown ContextCake profile: ${profileId}`);
  return manifest.profiles[profileId].layers;
}

function allRunnableLayerSets(manifest, mode) {
  if (mode === "legacy") return [["default", manifest.layers ?? []]];
  if (mode === "transitional") {
    return [["default", manifest.layers], ...Object.entries(manifest.profiles).filter(([id]) => id !== "default").map(([id, profile]) => [id, profile.layers])];
  }
  return Object.entries(manifest.profiles).map(([id, profile]) => [id, profile.layers]);
}

function normalizeToV2(manifest) {
  const existingProfiles = structuredClone(manifest.profiles ?? {});
  const output = structuredClone(manifest);
  delete output.layers;
  delete output.pendingSources;
  delete output.pendingSourcesOwnerUserId;
  const profiles = {};

  const existingDefault = existingProfiles.default ?? {};
  const legacyLayers = manifest.layers ?? [];
  const defaultIdentities = new Set(legacyLayers.map(sourceIdentity));
  const defaultPending = [
    ...(existingDefault.pendingSources ?? []),
    ...(manifest.pendingSources ?? []),
  ].filter((source) => !defaultIdentities.has(sourceIdentity(source)));
  for (const layer of existingDefault.layers ?? []) {
    if (!defaultIdentities.has(sourceIdentity(layer))) defaultPending.push(layer);
  }
  profiles.default = {
    ...existingDefault,
    label: normalizeProfileLabel(existingDefault.label ?? "Default"),
    layers: structuredClone(legacyLayers),
    ...nonEmptyPending(defaultPending),
    ...(manifest.pendingSourcesOwnerUserId ? { pendingSourcesOwnerUserId: manifest.pendingSourcesOwnerUserId } : {}),
  };

  for (const [profileId, profile] of Object.entries(existingProfiles)) {
    if (profileId === "default") continue;
    const runnable = [];
    const pending = [...(profile.pendingSources ?? [])];
    for (const layer of profile.layers ?? []) {
      if (isRunnableLayer(layer)) runnable.push(layer);
      else pending.push(layer);
    }
    const runnableIdentities = new Set(runnable.map(sourceIdentity));
    profiles[profileId] = {
      ...profile,
      label: normalizeProfileLabel(profile.label ?? profileId),
      layers: runnable,
      ...nonEmptyPending(pending.filter((source) => !runnableIdentities.has(sourceIdentity(source)))),
    };
  }
  output.profiles = profiles;
  output.projects ??= {};
  for (const record of Object.values(output.packs ?? {})) {
    for (const assignment of record.assignments ?? []) {
      if (assignment.profile === null || assignment.profile === undefined) assignment.profile = "default";
    }
  }
  return output;
}

function applyNewProfile(manifest, newProfile, projectPath, realpath) {
  if (!newProfile) {
    if (projectPath) throw new Error("A project mapping requires a new profile.");
    return;
  }
  const id = newProfile.id ?? createProfileId(newProfile.label, Object.keys(manifest.profiles));
  assertProfileId(id);
  if (Object.hasOwn(manifest.profiles, id)) throw new Error(`ContextCake profile already exists: ${id}`);
  manifest.profiles[id] = {
    label: normalizeProfileLabel(newProfile.label),
    layers: structuredClone(newProfile.layers ?? []),
    ...(newProfile.pendingSources?.length ? { pendingSources: structuredClone(newProfile.pendingSources) } : {}),
  };
  if (projectPath) {
    const canonical = canonicalExistingPath(projectPath, realpath, "Project mapping");
    for (const [existingRoot, existingId] of Object.entries(manifest.projects ?? {})) {
      let existingCanonical;
      try { existingCanonical = canonicalExistingPath(existingRoot, realpath, "Project mapping"); } catch { continue; }
      if (existingCanonical === canonical && existingId !== id) throw new Error(`Project mapping already belongs to profile ${existingId}: ${existingRoot}`);
    }
    manifest.projects ??= {};
    manifest.projects[canonical] = id;
  }
}

function validateNewProfile(profile, manifest) {
  assertObject(profile, "New profile");
  normalizeProfileLabel(profile.label);
  if (profile.id !== undefined) assertProfileId(profile.id);
  if (profile.id && Object.hasOwn(manifest.profiles ?? {}, profile.id)) throw new Error(`ContextCake profile already exists: ${profile.id}`);
  validateLayers(profile.layers ?? [], "new profile");
  if (profile.pendingSources) validatePendingSources(profile.pendingSources, "new profile");
}

function nonEmptyPending(sources) {
  const unique = [];
  const seen = new Set();
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const identity = sourceIdentity(source);
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(structuredClone(source));
  }
  return unique.length ? { pendingSources: unique } : {};
}

function isRunnableLayer(layer) {
  if (!layer || typeof layer !== "object" || Array.isArray(layer)) return false;
  const kind = layer.source ?? "okf-local";
  if ((kind === "okf-local" || kind === "files") && typeof layer.path !== "string") return false;
  if (kind === "mcp" && typeof layer.command !== "string") return false;
  if (kind === "github" && typeof layer.repo !== "string") return false;
  return RUNNABLE_SOURCE_KINDS.has(kind);
}

function sourceIdentity(source) {
  return `${source?.source ?? "okf-local"}\0${source?.name ?? ""}`;
}

function rejectCredentialFields(value, label) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
    if (CREDENTIAL_KEY_PATTERN.test(normalizedKey)) {
      throw new Error(`${label} contains forbidden raw credential field: ${key}`);
    }
    rejectCredentialFields(child, label);
  }
}

function rejectCredentialValues(value, label, { allowScrubbed = false } = {}, key = "") {
  if (allowScrubbed && isScrubMarker(value)) return;
  if (typeof value === "string") {
    if (key === "auth" && value.startsWith("keychain:")) return;
    if (CREDENTIAL_VALUE_PATTERN.test(value) || CREDENTIAL_ASSIGNMENT_PATTERN.test(value)) {
      throw new Error(`${label} contains a value that looks like a raw credential.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) rejectCredentialValues(entry, label, { allowScrubbed }, key);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) {
    rejectCredentialValues(childValue, label, { allowScrubbed }, childKey);
  }
}

function validateAuthReference(auth, label, { allowScrubbed = false } = {}) {
  if (auth === undefined || auth === null) return;
  if (allowScrubbed && isScrubMarker(auth)) return;
  if (typeof auth === "string" && /^keychain:[A-Za-z0-9._/-]+$/.test(auth)) return;
  if (
    auth && typeof auth === "object" && !Array.isArray(auth)
    && Object.keys(auth).length === 1
    && typeof auth.tokenEnv === "string"
    && /^[A-Za-z_][A-Za-z0-9_]*$/.test(auth.tokenEnv)
  ) return;
  throw new Error(`${label} auth must be a keychain alias or a tokenEnv reference, never a raw credential.`);
}

function isScrubMarker(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof value.__scrubbed === "string";
}

function writeVerifiedBackup(backupPath, bytes, expectedHash) {
  if (fs.existsSync(backupPath)) {
    verifyManifestBackup(backupPath, expectedHash);
    return;
  }
  writeAtomicBytes(backupPath, bytes, { exclusiveTarget: true });
  verifyManifestBackup(backupPath, expectedHash);
}

function writeAtomicJson(filePath, value) {
  writeAtomicBytes(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
}

function writeAtomicBytes(filePath, bytes, { exclusiveTarget = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (exclusiveTarget && fs.existsSync(filePath)) throw new Error(`Refusing to overwrite existing file: ${filePath}`);
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    if (exclusiveTarget) {
      try {
        // An exclusive hard link is the no-overwrite counterpart to rename:
        // the completed bytes become visible atomically, while a target that
        // appeared after our preflight check is never replaced.
        fs.linkSync(temporary, filePath);
      } catch (error) {
        if (error.code === "EEXIST") throw new Error(`Refusing to overwrite existing file: ${filePath}`);
        throw error;
      }
      fs.rmSync(temporary);
    } else {
      fs.renameSync(temporary, filePath);
    }
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function readManifestLock(lockPath) {
  try {
    const stat = fs.lstatSync(lockPath);
    const value = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    return { ...value, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch {
    try {
      const stat = fs.lstatSync(lockPath);
      return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
    } catch { return null; }
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function manifestLockIsStale(lock, staleMs) {
  if (!lock) return false;
  if (processIsAlive(lock.pid)) return false;
  const timestamp = Number.isFinite(lock.createdAt) ? lock.createdAt : lock.mtimeMs;
  const age = Date.now() - timestamp;
  return age > staleMs || age < -staleMs;
}

function tryAcquireManifestLock(lockPath, staleMs) {
  const token = crypto.randomUUID();
  const payload = { pid: process.pid, createdAt: Date.now(), token };
  try {
    fs.writeFileSync(lockPath, JSON.stringify(payload), { flag: "wx", mode: 0o600 });
    return token;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const observed = readManifestLock(lockPath);
  if (!manifestLockIsStale(observed, staleMs)) return null;
  const parked = `${lockPath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.stale`;
  try {
    fs.renameSync(lockPath, parked);
  } catch {
    return null;
  }

  // Another contender may have replaced the stale lock between our read and
  // rename. Restore that newer owner instead of treating it as the stale inode
  // we observed.
  const parkedLock = readManifestLock(parked);
  if (!parkedLock || parkedLock.dev !== observed?.dev || parkedLock.ino !== observed?.ino) {
    try { fs.renameSync(parked, lockPath); } catch { /* lock path was restored elsewhere */ }
    return null;
  }
  fs.rmSync(parked, { force: true });
  try {
    fs.writeFileSync(lockPath, JSON.stringify(payload), { flag: "wx", mode: 0o600 });
    return token;
  } catch (error) {
    if (error.code === "EEXIST") return null;
    throw error;
  }
}

function releaseManifestLock(lockPath, token) {
  try {
    // A delayed former holder must never delete a replacement lock.
    if (readManifestLock(lockPath)?.token !== token) return;
    fs.rmSync(lockPath, { force: true });
  } catch {
    // Releasing an advisory lock must not hide the mutation result.
  }
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function canonicalExistingPath(value, realpath, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  return path.normalize(realpath(value));
}

function canonicalConfiguredPath(manifestDir, value) {
  const resolved = path.resolve(manifestDir, value);
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}

function containsPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function pathDepth(value) {
  return path.normalize(value).split(path.sep).filter(Boolean).length;
}

function formatUtcTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Migration timestamp is invalid.");
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// Key-order-independent JSON. Exported because the service keys its background
// indexes on layer configuration, and JSON.stringify would mint a new key —
// re-reading the whole source — for a manifest rewrite that only reordered a
// layer's fields.
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function assertProfileId(value) {
  if (typeof value !== "string" || !PROFILE_ID_PATTERN.test(value) || FORBIDDEN_KEYS.has(value)) {
    throw new Error(`Invalid ContextCake profile id: ${String(value)}`);
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
}

function assertSafeKeys(value, location = "manifest") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`ContextCake manifest uses reserved key ${key} at ${location}.`);
    assertSafeKeys(child, `${location}.${key}`);
  }
}
