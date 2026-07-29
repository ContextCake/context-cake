#!/usr/bin/env node

// Read-only profile inspection and locked local profile configuration.
// No command in this file opens a source adapter.

import fs from "node:fs";
import path from "node:path";
import {
  classifyManifest,
  createProfileId,
  listManifestProfiles,
  migrateManifestToV2,
  mutateContextManifest,
  normalizeProfileLabel,
  readContextManifest,
  selectManifestProfile,
} from "./manifest.mjs";

main();

function main() {
  const { command, positionals, options } = parseArgs(process.argv.slice(2));
  if (options.help || !command || command === "help") {
    printHelp();
    process.exit(command || options.help ? 0 : 1);
  }
  if (!options.manifest) throw new Error("--manifest <file> is required.");
  const manifestPath = path.resolve(options.manifest);

  if (command === "current") return currentProfile(manifestPath, options);
  if (command === "list") return listProfiles(manifestPath, options);
  if (command === "create") return createProfile(manifestPath, positionals, options);
  if (command === "map") return mapProject(manifestPath, positionals, options);
  if (command === "unmap") return unmapProject(manifestPath, positionals, options);
  if (command === "delete") return deleteProfile(manifestPath, positionals, options);
  throw new Error(`Unknown profile command: ${command}`);
}

function currentProfile(manifestPath, options) {
  const manifest = readContextManifest(manifestPath, { allowMissing: false, validatePacks: false });
  const selected = selectManifestProfile(manifest, {
    requestedProfile: options.profile ?? null,
    cwd: process.cwd(),
  });
  const result = {
    id: selected.profileId,
    label: selected.profileLabel,
    reason: selected.reason,
    mode: selected.mode,
    sourceCount: selected.layers.length,
    ...(selected.matchedProjectRoot ? { matchedProjectRoot: selected.matchedProjectRoot } : {}),
    ...(selected.warnings.length ? { warnings: selected.warnings } : {}),
  };
  output(result, options, `${result.label} (${result.id}) — ${result.reason}${result.matchedProjectRoot ? `\nProject: ${result.matchedProjectRoot}` : ""}`);
}

function listProfiles(manifestPath, options) {
  const manifest = readContextManifest(manifestPath, { allowMissing: false, validatePacks: false });
  const profiles = listManifestProfiles(manifest);
  output(profiles, options, profiles.map((profile) => (
    `${profile.id}\t${profile.label}\t${profile.sourceCount} source${profile.sourceCount === 1 ? "" : "s"}`
      + `\t${profile.mappingCount} mapping${profile.mappingCount === 1 ? "" : "s"}`
      + `${profile.valid ? "" : "\tneeds repair"}`
  )).join("\n"));
}

function createProfile(manifestPath, positionals, options) {
  const label = normalizeProfileLabel(positionals.join(" "));
  const before = readContextManifest(manifestPath, { allowMissing: false });
  const id = createProfileId(label, Object.keys(before.profiles ?? {}));
  const result = migrateManifestToV2(manifestPath, {
    newProfile: { id, label, layers: [] },
    projectPath: options.project ? path.resolve(options.project) : null,
  });
  const response = {
    created: id,
    label,
    action: result.action,
    ...(options.project ? { project: fs.realpathSync.native(path.resolve(options.project)) } : {}),
    ...(result.backupPath ? { backupPath: result.backupPath, backupHash: result.backupHash } : {}),
  };
  output(response, options, `Created ${label} (${response.created})${response.project ? `\nMapped ${response.project}` : ""}${response.backupPath ? `\nBackup: ${response.backupPath}` : ""}`);
}

function mapProject(manifestPath, positionals, options) {
  const [profileId, projectPath] = positionals;
  if (!profileId || !projectPath || positionals.length !== 2) throw new Error("Usage: profile map <id> <path> --manifest <file>");
  const canonical = canonicalProjectPath(projectPath);
  mutateContextManifest(manifestPath, (manifest) => {
    requireV2(manifest, "Project mappings");
    if (!Object.hasOwn(manifest.profiles, profileId)) throw new Error(`Unknown ContextCake profile: ${profileId}`);
    manifest.projects ??= {};
    for (const [configuredRoot, configuredProfile] of Object.entries(manifest.projects)) {
      let existingCanonical;
      try { existingCanonical = fs.realpathSync.native(configuredRoot); } catch { continue; }
      if (existingCanonical !== canonical) continue;
      if (configuredProfile !== profileId) {
        throw new Error(`Project mapping already belongs to profile ${configuredProfile}: ${configuredRoot}`);
      }
      delete manifest.projects[configuredRoot];
    }
    manifest.projects[canonical] = profileId;
  }, { allowMissing: false });
  output({ mapped: canonical, profileId }, options, `Mapped ${canonical} -> ${profileId}`);
}

function unmapProject(manifestPath, positionals, options) {
  const [requested] = positionals;
  if (!requested || positionals.length !== 1) throw new Error("Usage: profile unmap <path> --manifest <file>");
  const absolute = path.resolve(requested);
  let canonical = null;
  try { canonical = fs.realpathSync.native(absolute); } catch { /* stale mapping can still be removed by exact path */ }
  let removed = null;
  mutateContextManifest(manifestPath, (manifest) => {
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
    if (!removed) throw new Error(`No project mapping for: ${absolute}`);
  }, { allowMissing: false });
  output({ unmapped: removed }, options, `Removed mapping ${removed}`);
}

function deleteProfile(manifestPath, positionals, options) {
  const [profileId] = positionals;
  if (!profileId || positionals.length !== 1) throw new Error("Usage: profile delete <id> --manifest <file> [--confirm]");
  if (profileId === "default") throw new Error("The default profile cannot be deleted.");
  const manifest = readContextManifest(manifestPath, { allowMissing: false });
  requireV2(manifest, "Profile deletion");
  if (!Object.hasOwn(manifest.profiles, profileId)) throw new Error(`Unknown ContextCake profile: ${profileId}`);
  const mappings = Object.keys(manifest.projects ?? {}).filter((root) => manifest.projects[root] === profileId);
  const packAssignments = [];
  for (const [packId, record] of Object.entries(manifest.packs ?? {})) {
    if ((record.assignments ?? []).some((assignment) => assignment.profile === profileId)) packAssignments.push(packId);
  }
  const preview = { profileId, mappings, packAssignments, sourceCount: manifest.profiles[profileId].layers.length };
  if (!options.confirm) {
    output({ ...preview, deleted: false, confirmationRequired: true }, options,
      `Delete ${profileId}? ${mappings.length} project mapping(s), ${packAssignments.length} Pack assignment(s), and the profile reference will be removed.\nUnderlying source, Pack, overlay, cache, and live-repository files will remain.\nRe-run with --confirm.`);
    process.exitCode = 2;
    return;
  }
  mutateContextManifest(manifestPath, (candidate) => {
    requireV2(candidate, "Profile deletion");
    if (!Object.hasOwn(candidate.profiles, profileId)) throw new Error(`Unknown ContextCake profile: ${profileId}`);
    delete candidate.profiles[profileId];
    for (const [root, assignedProfile] of Object.entries(candidate.projects ?? {})) {
      if (assignedProfile === profileId) delete candidate.projects[root];
    }
    for (const record of Object.values(candidate.packs ?? {})) {
      record.assignments = (record.assignments ?? []).filter((assignment) => assignment.profile !== profileId);
    }
  }, { allowMissing: false });
  output({ ...preview, deleted: true }, options, `Deleted profile ${profileId}. Underlying files were not removed.`);
}

function canonicalProjectPath(value) {
  const absolute = path.resolve(value);
  const stat = fs.statSync(absolute);
  if (!stat.isDirectory()) throw new Error(`Project mapping must name a directory: ${absolute}`);
  return fs.realpathSync.native(absolute);
}

function requireV2(manifest, operation) {
  if (classifyManifest(manifest) !== "v2") {
    throw new Error(`${operation} require Manifest v2. Create a profile first to migrate this manifest safely.`);
  }
}

function output(value, options, text) {
  console.log(options.json ? JSON.stringify(value, null, 2) : text);
}

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  let command = null;
  const booleanFlags = new Set(["json", "confirm", "help"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h") options.help = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (booleanFlags.has(key)) options[key] = true;
      else {
        if (argv[index + 1] === undefined || argv[index + 1].startsWith("--")) throw new Error(`${arg} requires a value.`);
        options[key] = argv[index + 1];
        index += 1;
      }
    } else if (command === null) command = arg;
    else positionals.push(arg);
  }
  return { command, positionals, options };
}

function printHelp() {
  console.log(`Usage: contextcake profile <command> [options]

  current [--profile <id>] [--json]  Show the selected profile and reason
  list [--json]                      List profiles without opening sources
  create <label> [--project <path>] Create an empty profile; safely migrate legacy manifests
  map <id> <path>                    Map a local project folder to a profile
  unmap <path>                       Remove one project mapping
  delete <id> [--confirm]            Remove references only; never source files

All commands require --manifest <file>. Automatic selection uses the current
working directory; --profile wins when provided to current.
`);
}
