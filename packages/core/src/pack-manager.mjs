// Local, dependency-free ContextCake Pack management.
//
// Packs are data, never programs: the installer accepts only inspectable text
// formats, rejects symlinks, and never executes anything from the source tree.
// Installed versions are immutable and retained so switching or removing a
// Pack cannot destroy the user's locally retained content or overlays.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ALLOWED_EXTENSIONS = new Set([".md", ".yaml", ".yml", ".json", ".txt"]);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PACK_BYTES = 25 * 1024 * 1024;
const MAX_PACK_ENTRIES = 2_000;
const PACK_CONTRACT = "1";
const MANIFEST_FILE = "PACK.yaml";
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const REQUIRED_SCALARS = [
  ["id"], ["name"], ["version"],
  ["hero_workflow"],
  ["changelog"],
  ["creator", "name"], ["creator", "url"],
  ["license", "model"], ["license", "terms_url"],
  ["update_policy", "cadence"], ["update_policy", "base_purchase"],
  ["update_policy", "corrections"], ["update_policy", "editorial_updates"],
  ["rights", "attested"], ["rights", "disclosure"],
  ["freshness", "reviewed_at"],
  ["permissions", "content_only"], ["permissions", "executable_code"],
  ["permissions", "network_access"], ["permissions", "credentials"],
  ["compatibility", "contextcake"], ["compatibility", "pack_contract"],
  ["review", "status"], ["review", "reviewed_by"], ["review", "reviewed_at"],
  ["artifact", "checksum_algorithm"], ["artifact", "checksum_scope"], ["artifact", "checksum"],
];

/** Validate and describe a local Pack without changing it. */
export function inspectPack(sourceRoot, { expectedChecksum } = {}) {
  const root = path.resolve(sourceRoot);
  const rootStat = safeLstat(root, "Pack source does not exist");
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Pack source must be a real directory, not a file or symlink.");
  }

  const manifestPath = path.join(root, MANIFEST_FILE);
  const manifestStat = safeLstat(manifestPath, "Pack source is missing PACK.yaml");
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw new Error("PACK.yaml must be a regular file.");
  }
  if (manifestStat.size > MAX_FILE_BYTES) throw new Error("PACK.yaml exceeds the 5 MB per-file limit.");

  const rawManifest = fs.readFileSync(manifestPath, "utf8");
  const errors = validateTrustContract(rawManifest);
  const entries = walkPackEntries(root, errors);
  const filePaths = new Set(entries.filter((entry) => entry.stat.isFile()).map((entry) => entry.relative));
  const sampleFiles = readYamlList(rawManifest, "sample_files");
  if (sampleFiles.length === 0) errors.push("PACK.yaml sample_files must contain at least one inspectable sample.");
  for (const sample of sampleFiles) {
    if (typeof sample !== "string" || isUnsafeRelativePath(sample) || !filePaths.has(sample)) errors.push(`PACK.yaml sample file does not exist inside the Pack: ${sample}`);
  }
  const changelog = readYamlPath(rawManifest, ["changelog"]);
  if (typeof changelog === "string" && (isUnsafeRelativePath(changelog) || !filePaths.has(changelog))) errors.push(`PACK.yaml changelog does not exist inside the Pack: ${changelog}`);
  if (errors.length) throw new Error(`Pack validation failed:\n- ${errors.join("\n- ")}`);

  const checksum = checksumEntries(root, entries);
  const declaredChecksum = readYamlPath(rawManifest, ["artifact", "checksum"]);
  const normalizedExpected = normalizeExpectedChecksum(expectedChecksum);
  if (normalizedExpected && normalizedExpected !== checksum) {
    throw new Error(`Pack checksum mismatch: expected ${normalizedExpected}, received ${checksum}.`);
  }
  if (declaredChecksum !== "pending-release" && declaredChecksum !== checksum) {
    throw new Error(`PACK.yaml checksum mismatch: declared ${declaredChecksum}, received ${checksum}.`);
  }

  return {
    id: readYamlPath(rawManifest, ["id"]),
    name: readYamlPath(rawManifest, ["name"]),
    version: readYamlPath(rawManifest, ["version"]),
    creator: {
      name: readYamlPath(rawManifest, ["creator", "name"]),
      url: readYamlPath(rawManifest, ["creator", "url"]),
    },
    license: {
      model: readYamlPath(rawManifest, ["license", "model"]),
      termsUrl: readYamlPath(rawManifest, ["license", "terms_url"]),
      personalPriceUsd: readYamlPath(rawManifest, ["license", "personal_price_usd"]),
      teamPriceUsd: readYamlPath(rawManifest, ["license", "team_price_usd"]),
      teamSeats: readYamlPath(rawManifest, ["license", "team_seats"]),
    },
    heroWorkflow: readYamlPath(rawManifest, ["hero_workflow"]),
    supportedSurfaces: readYamlList(rawManifest, "supported_surfaces"),
    updatePolicy: {
      cadence: readYamlPath(rawManifest, ["update_policy", "cadence"]),
      basePurchase: readYamlPath(rawManifest, ["update_policy", "base_purchase"]),
      corrections: readYamlPath(rawManifest, ["update_policy", "corrections"]),
      editorialUpdates: readYamlPath(rawManifest, ["update_policy", "editorial_updates"]),
    },
    sourceDisclosures: readYamlList(rawManifest, "source_disclosures"),
    rights: {
      attested: readYamlPath(rawManifest, ["rights", "attested"]),
      disclosure: readYamlPath(rawManifest, ["rights", "disclosure"]),
    },
    freshness: readYamlPath(rawManifest, ["freshness", "reviewed_at"]),
    reviewStatus: readYamlPath(rawManifest, ["review", "status"]),
    samples: sampleFiles,
    changelog,
    permissions: {
      contentOnly: true,
      executableCode: false,
      networkAccess: false,
      credentials: false,
    },
    checksum,
    files: entries.filter((entry) => entry.stat.isFile()).map((entry) => entry.relative),
    bytes: entries.reduce((sum, entry) => sum + (entry.stat.isFile() ? entry.stat.size : 0), 0),
  };
}

/** Compare a candidate release with the active retained version without writing. */
export function previewPackUpdate({
  sourceRoot,
  manifestPath,
  packsDir = path.join(path.dirname(path.resolve(manifestPath)), "packs"),
  profile = null,
  expectedChecksum,
}) {
  const candidate = inspectPack(sourceRoot, { expectedChecksum });
  const resolvedManifestPath = path.resolve(manifestPath);
  const resolvedPacksDir = path.resolve(packsDir);
  const manifest = readContextManifest(resolvedManifestPath);
  const record = readPackRecord(manifest, candidate.id);
  if (!record) throw new Error(`Pack is not installed: ${candidate.id}`);
  const assignment = record.assignments.find((entry) => entry.profile === (profile ?? null));
  if (!assignment) throw new Error(`Pack ${candidate.id} is not attached to ${profile ? `profile ${profile}` : "the default stack"}.`);
  const active = record.installedVersions.find((entry) => entry.version === assignment.activeVersion);
  if (!active) throw new Error(`Pack registry is missing the active version ${candidate.id}@${assignment.activeVersion}.`);
  const activeRoot = safeChildPath(resolvedPacksDir, candidate.id, active.version);
  const current = inspectPack(activeRoot, { expectedChecksum: active.checksum });
  return {
    action: "update-preview",
    id: candidate.id,
    profile: profile ?? null,
    fromVersion: current.version,
    toVersion: candidate.version,
    currentChecksum: current.checksum,
    candidateChecksum: candidate.checksum,
    changes: comparePackFiles(activeRoot, path.resolve(sourceRoot)),
    permissions: candidate.permissions,
  };
}

/** Install or update a Pack and attach its base layer to one profile. */
export function installPack({
  sourceRoot,
  manifestPath,
  packsDir = path.join(path.dirname(path.resolve(manifestPath)), "packs"),
  profile = null,
  level = null,
  expectedChecksum,
  allowUpdate = false,
}) {
  const pack = inspectPack(sourceRoot, { expectedChecksum });
  const resolvedManifestPath = path.resolve(manifestPath);
  const resolvedPacksDir = path.resolve(packsDir);
  const manifest = readContextManifest(resolvedManifestPath);
  const layers = selectProfileLayers(manifest, profile);
  const registry = ensurePackRegistry(manifest);
  const record = registry[pack.id] ? readPackRecord(manifest, pack.id) : {
    id: pack.id,
    name: pack.name,
    creator: pack.creator.name,
    license: pack.license.model,
    installedVersions: [],
    assignments: [],
  };
  registry[pack.id] = record;

  const profileKey = profile ?? null;
  const existingAssignment = record.assignments.find((entry) => entry.profile === profileKey);
  const priorVersion = existingAssignment?.activeVersion ?? null;
  const numericLevel = level === null || level === undefined ? Number(existingAssignment?.level ?? 0) : Number(level);
  if (!Number.isInteger(numericLevel) || numericLevel < -100 || numericLevel > 100) {
    throw new Error("Pack precedence level must be an integer between -100 and 100.");
  }
  if (priorVersion && priorVersion !== pack.version && !allowUpdate) {
    throw new Error(`Pack ${pack.id}@${priorVersion} is already active. Run pack update to review ${pack.version} before applying it.`);
  }
  const updatePreview = priorVersion && priorVersion !== pack.version
    ? previewPackUpdate({ sourceRoot, manifestPath: resolvedManifestPath, packsDir: resolvedPacksDir, profile, expectedChecksum })
    : null;

  const existingVersion = record.installedVersions.find((entry) => entry.version === pack.version);
  if (existingVersion && existingVersion.checksum !== pack.checksum) {
    throw new Error(`Installed Pack ${pack.id}@${pack.version} has a different checksum.`);
  }
  const versionRoot = safeChildPath(resolvedPacksDir, pack.id, pack.version);
  const installed = installImmutableVersion(sourceRoot, versionRoot, pack.checksum);
  if (!existingVersion) {
    record.installedVersions.push({
      version: pack.version,
      checksum: pack.checksum,
      installedAt: new Date().toISOString(),
    });
  }

  let assignment = record.assignments.find((entry) => entry.profile === profileKey);
  if (!assignment) {
    assignment = {
      profile: profileKey,
      layerName: availableLayerName(layers, `pack-${pack.id}`),
      activeVersion: pack.version,
      level: numericLevel,
    };
    record.assignments.push(assignment);
  } else {
    assignment.activeVersion = pack.version;
    assignment.level = numericLevel;
  }

  upsertPackLayer(layers, assignment, pack.id, versionRoot, resolvedManifestPath);
  writeContextManifest(resolvedManifestPath, manifest);

  return {
    action: priorVersion && priorVersion !== pack.version ? "updated" : installed ? "installed" : "attached",
    pack,
    profile: profileKey,
    level: numericLevel,
    installedPath: versionRoot,
    priorVersion,
    ...(updatePreview ? { changes: updatePreview.changes } : {}),
  };
}

/** Point an assignment at a retained version; no files are overwritten. */
export function rollbackPack({ manifestPath, packId, profile = null, version = null, packsDir }) {
  const resolvedManifestPath = path.resolve(manifestPath);
  const resolvedPacksDir = path.resolve(packsDir ?? path.join(path.dirname(resolvedManifestPath), "packs"));
  const manifest = readContextManifest(resolvedManifestPath);
  const record = readPackRecord(manifest, packId);
  if (!record) throw new Error(`Pack is not installed: ${packId}`);
  const assignment = record.assignments?.find((entry) => entry.profile === (profile ?? null));
  if (!assignment) throw new Error(`Pack ${packId} is not attached to ${profile ? `profile ${profile}` : "the default stack"}.`);

  const candidates = record.installedVersions.filter((entry) => entry.version !== assignment.activeVersion);
  const selected = version
    ? record.installedVersions.find((entry) => entry.version === version)
    : candidates.at(-1);
  if (!selected) throw new Error(version ? `Pack version is not installed: ${packId}@${version}` : `No previous version is retained for ${packId}.`);

  const versionRoot = safeChildPath(resolvedPacksDir, packId, selected.version);
  const inspected = inspectPack(versionRoot, { expectedChecksum: selected.checksum });
  const layers = selectProfileLayers(manifest, profile);
  const priorVersion = assignment.activeVersion;
  assignment.activeVersion = selected.version;
  upsertPackLayer(layers, assignment, packId, versionRoot, resolvedManifestPath);
  writeContextManifest(resolvedManifestPath, manifest);
  return { action: "rolled-back", pack: inspected, profile: profile ?? null, priorVersion };
}

/** Detach a Pack layer but deliberately retain every downloaded version. */
export function removePack({ manifestPath, packId, profile = null }) {
  const resolvedManifestPath = path.resolve(manifestPath);
  const manifest = readContextManifest(resolvedManifestPath);
  const record = readPackRecord(manifest, packId);
  if (!record) throw new Error(`Pack is not installed: ${packId}`);
  const profileKey = profile ?? null;
  const assignmentIndex = record.assignments?.findIndex((entry) => entry.profile === profileKey) ?? -1;
  if (assignmentIndex < 0) throw new Error(`Pack ${packId} is not attached to ${profile ? `profile ${profile}` : "the default stack"}.`);

  const [assignment] = record.assignments.splice(assignmentIndex, 1);
  const layers = selectProfileLayers(manifest, profile);
  const layerIndex = layers.findIndex((layer) => layer.name === assignment.layerName && isPackOrigin(layer.origin, packId));
  if (layerIndex >= 0) layers.splice(layerIndex, 1);
  writeContextManifest(resolvedManifestPath, manifest);
  return {
    action: "detached",
    id: packId,
    profile: profileKey,
    retainedVersions: record.installedVersions.map((entry) => entry.version),
  };
}

export function listPacks(manifestPath) {
  const manifest = readContextManifest(path.resolve(manifestPath));
  return Object.values(manifest.packs ?? {}).map((record) => ({
    id: record.id,
    name: record.name,
    creator: record.creator,
    license: record.license,
    installedVersions: record.installedVersions ?? [],
    assignments: record.assignments ?? [],
  }));
}

function validateTrustContract(content) {
  const errors = validateManifestSyntax(content);
  for (const yamlPath of REQUIRED_SCALARS) {
    if (readYamlPath(content, yamlPath) === null) errors.push(`PACK.yaml is missing ${yamlPath.join(".")}.`);
  }
  const id = readYamlPath(content, ["id"]);
  if (id && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) errors.push("PACK.yaml id must be a lowercase slug.");
  if (FORBIDDEN_KEYS.has(id)) errors.push("PACK.yaml id uses a reserved object key.");
  const version = readYamlPath(content, ["version"]);
  if (version && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) errors.push("PACK.yaml version must be semver.");
  for (const yamlPath of [["name"], ["hero_workflow"], ["rights", "disclosure"]]) {
    const value = readYamlPath(content, yamlPath);
    if (typeof value === "string" && !value.trim()) errors.push(`PACK.yaml ${yamlPath.join(".")} must not be empty.`);
  }
  const supportedSurfaces = readYamlList(content, "supported_surfaces");
  if (supportedSurfaces.length === 0 || supportedSurfaces.some((value) => typeof value !== "string" || !value.trim())) errors.push("PACK.yaml supported_surfaces must contain non-empty values.");
  const sourceDisclosures = readYamlList(content, "source_disclosures");
  if (sourceDisclosures.length === 0 || sourceDisclosures.some((value) => typeof value !== "string" || !value.trim())) errors.push("PACK.yaml source_disclosures must contain non-empty values.");
  validateHttpsUrl(content, ["creator", "url"], errors);
  validateHttpsUrl(content, ["license", "terms_url"], errors);
  const licenseModel = readYamlPath(content, ["license", "model"]);
  if (!new Set(["free", "personal-and-team"]).has(licenseModel)) errors.push("PACK.yaml license.model must be free or personal-and-team.");
  if (licenseModel === "personal-and-team") {
    const pair = `${readYamlPath(content, ["license", "personal_price_usd"])}/${readYamlPath(content, ["license", "team_price_usd"])}`;
    if (!new Set(["19/49", "49/129", "99/249", "149/399"]).has(pair)) errors.push("PACK.yaml paid license prices must use a reviewed personal/team price band.");
    if (readYamlPath(content, ["license", "team_seats"]) !== 5) errors.push("PACK.yaml paid team license must cover exactly 5 users.");
  }
  if (readYamlPath(content, ["update_policy", "base_purchase"]) !== "perpetual") errors.push("PACK.yaml update_policy.base_purchase must be perpetual.");
  if (readYamlPath(content, ["update_policy", "corrections"]) !== "included") errors.push("PACK.yaml update_policy.corrections must be included.");
  if (!new Set(["included", "optional-subscription"]).has(readYamlPath(content, ["update_policy", "editorial_updates"]))) errors.push("PACK.yaml update_policy.editorial_updates must be included or optional-subscription.");
  validateDate(content, ["freshness", "reviewed_at"], errors);
  validateDate(content, ["review", "reviewed_at"], errors);
  if (!new Set(["first-party", "approved"]).has(readYamlPath(content, ["review", "status"]))) errors.push("PACK.yaml review.status must be first-party or approved.");
  expectValue(content, ["rights", "attested"], true, errors);
  expectValue(content, ["permissions", "content_only"], true, errors);
  expectValue(content, ["permissions", "executable_code"], false, errors);
  expectValue(content, ["permissions", "network_access"], false, errors);
  expectValue(content, ["permissions", "credentials"], false, errors);
  if (String(readYamlPath(content, ["compatibility", "pack_contract"])) !== PACK_CONTRACT) errors.push(`PACK.yaml compatibility.pack_contract must be ${PACK_CONTRACT}.`);
  if (readYamlPath(content, ["artifact", "checksum_algorithm"]) !== "sha256") errors.push("PACK.yaml artifact.checksum_algorithm must be sha256.");
  if (readYamlPath(content, ["artifact", "checksum_scope"]) !== "canonical-content-tree") errors.push("PACK.yaml artifact.checksum_scope must be canonical-content-tree.");
  const checksum = readYamlPath(content, ["artifact", "checksum"]);
  if (checksum && checksum !== "pending-release" && !/^sha256:[a-f0-9]{64}$/.test(checksum)) errors.push("PACK.yaml artifact.checksum must be pending-release or sha256:<64 lowercase hex>.");
  return errors;
}

function walkPackEntries(root, errors) {
  const entries = [];
  const stack = [root];
  let totalBytes = 0;
  while (stack.length) {
    const current = stack.pop();
    for (const name of fs.readdirSync(current).sort()) {
      const fullPath = path.join(current, name);
      const stat = fs.lstatSync(fullPath);
      const relative = toPosix(path.relative(root, fullPath));
      entries.push({ path: fullPath, relative, stat });
      if (entries.length > MAX_PACK_ENTRIES) {
        errors.push(`Pack exceeds the ${MAX_PACK_ENTRIES}-entry limit.`);
        return entries;
      }
      if (relative.length > 500) errors.push(`${relative.slice(0, 80)}… exceeds the 500-character path limit.`);
      if (stat.isSymbolicLink()) {
        errors.push(`${relative} is a symlink; Pack symlinks are not allowed.`);
      } else if (stat.isDirectory()) {
        if (name === "node_modules" || name === ".git") errors.push(`${relative} is not allowed in a Pack.`);
        else stack.push(fullPath);
      } else if (stat.isFile()) {
        if (!ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase())) errors.push(`${relative} is not an inspectable Pack content type.`);
        if (stat.size > MAX_FILE_BYTES) errors.push(`${relative} exceeds the 5 MB per-file limit.`);
        totalBytes += stat.size;
      } else {
        errors.push(`${relative} is not a regular file or directory.`);
      }
    }
  }
  if (totalBytes > MAX_PACK_BYTES) errors.push("Pack exceeds the 25 MB unpacked size limit.");
  return entries.sort((a, b) => a.relative.localeCompare(b.relative));
}

function checksumEntries(root, entries) {
  const hash = crypto.createHash("sha256");
  for (const entry of entries) {
    if (!entry.stat.isFile()) continue;
    hash.update(entry.relative);
    hash.update("\0");
    let content = fs.readFileSync(path.join(root, entry.relative));
    if (entry.relative === MANIFEST_FILE) {
      // Normalize the declared tree checksum to avoid a self-referential hash.
      content = Buffer.from(content.toString("utf8").replace(/(^\s*checksum:\s*).+$/m, "$1\"pending-release\""));
    }
    hash.update(content);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function installImmutableVersion(sourceRoot, targetRoot, checksum) {
  ensureRealDirectory(path.dirname(path.dirname(targetRoot)), "Pack store");
  ensureRealDirectory(path.dirname(targetRoot), "Pack id directory");
  if (fs.existsSync(targetRoot)) {
    const existing = inspectPack(targetRoot, { expectedChecksum: checksum });
    if (existing.checksum !== checksum) throw new Error(`Installed Pack directory differs from ${checksum}.`);
    return false;
  }
  const staging = `${targetRoot}.install-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.mkdirSync(staging, { mode: 0o755 });
    copyPackTree(path.resolve(sourceRoot), staging);
    const copied = inspectPack(staging, { expectedChecksum: checksum });
    if (copied.checksum !== checksum) throw new Error("Pack changed while it was being installed.");
    fs.renameSync(staging, targetRoot);
    return true;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function copyPackTree(source, destination) {
  for (const name of fs.readdirSync(source).sort()) {
    const from = path.join(source, name);
    const to = path.join(destination, name);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error(`Pack changed during install: ${name} became a symlink.`);
    if (stat.isDirectory()) {
      fs.mkdirSync(to, { mode: 0o755 });
      copyPackTree(from, to);
    } else if (stat.isFile()) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, 0o644);
    } else {
      throw new Error(`Pack changed during install: ${name} is not a regular entry.`);
    }
  }
}

function readContextManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return { layers: [] };
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("ContextCake manifest must be a JSON object.");
  if (parsed.layers !== undefined && !Array.isArray(parsed.layers)) throw new Error("ContextCake manifest layers must be an array.");
  parsed.layers ??= [];
  return parsed;
}

function writeContextManifest(manifestPath, manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  const temporary = `${manifestPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, manifestPath);
    fs.chmodSync(manifestPath, 0o600);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function selectProfileLayers(manifest, profile) {
  if (!profile) return manifest.layers;
  if (FORBIDDEN_KEYS.has(profile) || !manifest.profiles || !Object.hasOwn(manifest.profiles, profile)) throw new Error(`Unknown ContextCake profile: ${profile}`);
  const selected = manifest.profiles[profile];
  if (!Array.isArray(selected.layers)) throw new Error(`Profile ${profile} does not have a layers array.`);
  return selected.layers;
}

function ensurePackRegistry(manifest) {
  if (manifest.packs === undefined) manifest.packs = {};
  if (!manifest.packs || typeof manifest.packs !== "object" || Array.isArray(manifest.packs)) throw new Error("ContextCake manifest packs registry must be an object.");
  return manifest.packs;
}

function readPackRecord(manifest, packId) {
  if (!manifest.packs || !Object.hasOwn(manifest.packs, packId)) return null;
  const record = manifest.packs[packId];
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(`Pack registry entry is invalid: ${packId}`);
  if (!Array.isArray(record.installedVersions) || !Array.isArray(record.assignments)) throw new Error(`Pack registry entry is missing version or assignment arrays: ${packId}`);
  return record;
}

function upsertPackLayer(layers, assignment, packId, versionRoot, manifestPath) {
  const layer = {
    name: assignment.layerName,
    level: assignment.level,
    source: "okf-local",
    path: portablePath(path.dirname(manifestPath), versionRoot),
    origin: `pack:${packId}@${assignment.activeVersion}`,
  };
  const index = layers.findIndex((candidate) => candidate.name === assignment.layerName && isPackOrigin(candidate.origin, packId));
  if (index >= 0) layers[index] = layer;
  else layers.push(layer);
}

function availableLayerName(layers, base) {
  if (!layers.some((layer) => layer.name === base)) return base;
  let suffix = 2;
  while (layers.some((layer) => layer.name === `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function isPackOrigin(origin, packId) {
  return typeof origin === "string" && origin.startsWith(`pack:${packId}@`);
}

function portablePath(manifestDir, target) {
  const relative = path.relative(manifestDir, target);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
    ? toPosix(relative)
    : target;
}

function safeChildPath(root, id, version) {
  const candidate = path.resolve(root, id, version);
  const prefix = `${root}${path.sep}`;
  if (!candidate.startsWith(prefix)) throw new Error("Pack id or version escapes the Pack store.");
  return candidate;
}

function isUnsafeRelativePath(value) {
  const normalized = path.posix.normalize(String(value).replace(/\\/g, "/"));
  return normalized === "." || normalized === ".." || normalized.startsWith("/") || normalized.startsWith("../") || normalized.includes("/../") || normalized.endsWith("/..");
}

function ensureRealDirectory(directory, label) {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a real directory, not a file or symlink.`);
}

function safeLstat(filePath, message) {
  try { return fs.lstatSync(filePath); } catch { throw new Error(`${message}: ${filePath}`); }
}

function expectValue(content, yamlPath, expected, errors) {
  const actual = readYamlPath(content, yamlPath);
  if (actual !== null && actual !== expected) errors.push(`PACK.yaml ${yamlPath.join(".")} must be ${expected}.`);
}

function validateManifestSyntax(content) {
  const errors = [];
  const stack = [];
  const seen = new Set();
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (rawLine.includes("\t")) {
      errors.push(`PACK.yaml:${index + 1} tabs are not allowed in indentation.`);
      continue;
    }
    const indent = rawLine.length - rawLine.trimStart().length;
    if (indent % 2 !== 0) errors.push(`PACK.yaml:${index + 1} indentation must use two-space steps.`);
    if (/^(?:!|&|\*|<<:)/.test(trimmed)) errors.push(`PACK.yaml:${index + 1} YAML tags, anchors, aliases, and merge keys are not supported.`);
    if (trimmed.startsWith("- ")) continue;
    const match = rawLine.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      errors.push(`PACK.yaml:${index + 1} is outside the supported manifest subset.`);
      continue;
    }
    const depth = Math.floor(indent / 2);
    stack.length = depth;
    stack[depth] = match[2];
    const keyPath = stack.slice(0, depth + 1).join(".");
    if (seen.has(keyPath)) errors.push(`PACK.yaml:${index + 1} duplicates ${keyPath}.`);
    seen.add(keyPath);
    if (FORBIDDEN_KEYS.has(match[2])) errors.push(`PACK.yaml:${index + 1} uses a reserved object key.`);
  }
  return errors;
}

function validateHttpsUrl(content, yamlPath, errors) {
  const value = readYamlPath(content, yamlPath);
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error();
  } catch {
    errors.push(`PACK.yaml ${yamlPath.join(".")} must be a credential-free HTTPS URL.`);
  }
}

function validateDate(content, yamlPath, errors) {
  const value = readYamlPath(content, yamlPath);
  const date = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    errors.push(`PACK.yaml ${yamlPath.join(".")} must be a valid YYYY-MM-DD date.`);
  }
}

function comparePackFiles(currentRoot, candidateRoot) {
  const current = fileDigestMap(currentRoot);
  const candidate = fileDigestMap(candidateRoot);
  const currentPaths = new Set(current.keys());
  const candidatePaths = new Set(candidate.keys());
  const added = [...candidatePaths].filter((file) => !currentPaths.has(file)).sort();
  const removed = [...currentPaths].filter((file) => !candidatePaths.has(file)).sort();
  const changed = [...candidatePaths].filter((file) => current.has(file) && current.get(file) !== candidate.get(file)).sort();
  const unchangedCount = [...candidatePaths].filter((file) => current.get(file) === candidate.get(file)).length;
  return { added, removed, changed, unchangedCount };
}

function fileDigestMap(root) {
  const errors = [];
  const entries = walkPackEntries(root, errors);
  if (errors.length) throw new Error(`Pack validation failed:\n- ${errors.join("\n- ")}`);
  return new Map(entries.filter((entry) => entry.stat.isFile()).map((entry) => [
    entry.relative,
    crypto.createHash("sha256").update(fs.readFileSync(entry.path)).digest("hex"),
  ]));
}

function readYamlPath(content, yamlPath) {
  const stack = [];
  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#") || rawLine.trimStart().startsWith("- ")) continue;
    const match = rawLine.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const depth = Math.floor(match[1].length / 2);
    stack.length = depth;
    stack[depth] = match[2];
    const currentPath = stack.slice(0, depth + 1);
    if (currentPath.length === yamlPath.length && currentPath.every((part, index) => part === yamlPath[index])) {
      return match[3].trim() ? parseYamlScalar(match[3].trim()) : null;
    }
  }
  return null;
}

function readYamlList(content, key) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start < 0) return [];
  const values = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[^\s]/.test(lines[index])) break;
    const item = lines[index].match(/^\s{2}-\s+(.+)$/);
    if (item) values.push(parseYamlScalar(item[1].trim()));
  }
  return values;
}

function parseYamlScalar(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function normalizeExpectedChecksum(value) {
  if (!value) return null;
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
