import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  classifyManifest,
  createProfileId,
  getManifestProfileLayers,
  listManifestProfiles,
  manifestRevision,
  migrateManifestToV2,
  mutateContextManifest,
  normalizeProfileLabel,
  readContextManifest,
  selectManifestProfile,
  sourceConfigFingerprint,
  validateContextManifest,
  verifyManifestBackup,
  withManifestLock,
  writeContextManifest,
} from "../src/manifest.mjs";
import { withCache } from "../src/sources/cache.mjs";
import { buildSources } from "../src/sources/index.mjs";
import { mergeSyncedSettings, prepareSyncPayload } from "../../../apps/desktop/src/main/settings-sync.mjs";

const testFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(testFile), "../../..");
const manifestModule = path.join(repoRoot, "packages/core/src/manifest.mjs");
const packManagerModule = path.join(repoRoot, "packages/core/src/pack-manager.mjs");

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "contextcake-manifest-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function profile(label = "Default", layers = []) {
  return { label, layers };
}

test("legacy manifests remain virtual, explicit-default compatible, and unmodified", () => {
  const manifest = { layers: [{ name: "local", level: 3, path: "notes" }] };
  const before = JSON.stringify(manifest);
  assert.equal(classifyManifest(manifest), "legacy");
  assert.deepEqual(selectManifestProfile(manifest, { cwd: process.cwd() }), {
    mode: "legacy",
    profileId: "default",
    profileLabel: "Default",
    layers: manifest.layers,
    reason: "legacy-default",
    matchedProjectRoot: null,
    warnings: [],
  });
  assert.equal(selectManifestProfile(manifest, { requestedProfile: "default" }).reason, "explicit");
  assert.throws(() => selectManifestProfile(manifest, { requestedProfile: "work" }), /requires migration/);
  assert.equal(JSON.stringify(manifest), before);
  assert.equal(getManifestProfileLayers(manifest), manifest.layers);
});

test("v2 selection uses explicit override, deepest canonical mapping, and default fallback", (t) => {
  const root = temporaryDirectory(t);
  const project = path.join(root, "project");
  const nested = path.join(project, "packages", "api");
  const nestedSource = path.join(nested, "src");
  const sibling = path.join(root, "project-old");
  fs.mkdirSync(nestedSource, { recursive: true });
  fs.mkdirSync(sibling);
  const manifest = {
    profiles: {
      default: profile(),
      project: profile("Project"),
      api: profile("API"),
    },
    projects: {
      [project]: "project",
      [nested]: "api",
    },
  };

  const selected = selectManifestProfile(manifest, { cwd: nestedSource });
  assert.equal(selected.profileId, "api");
  assert.equal(selected.reason, "project");
  assert.equal(selected.matchedProjectRoot, fs.realpathSync.native(nested));
  assert.equal(selectManifestProfile(manifest, { requestedProfile: "project", cwd: nested }).reason, "explicit");
  assert.equal(selectManifestProfile(manifest, { cwd: sibling }).profileId, "default");
  assert.equal(selectManifestProfile(manifest, { cwd: sibling }).reason, "default");
});

test("selection rejects alias conflicts and intended mappings to unknown profiles", (t) => {
  const root = temporaryDirectory(t);
  const project = path.join(root, "project");
  const alias = path.join(root, "project-alias");
  fs.mkdirSync(project);
  fs.symlinkSync(project, alias, "dir");
  const conflict = {
    profiles: { default: profile(), one: profile("One"), two: profile("Two") },
    projects: { [project]: "one", [alias]: "two" },
  };
  assert.throws(() => selectManifestProfile(conflict, { cwd: project }), /same canonical root/);

  const dangling = {
    profiles: { default: profile() },
    projects: { [project]: "missing" },
  };
  assert.throws(() => selectManifestProfile(dangling, { cwd: project }), /Unknown ContextCake profile: missing/);
});

test("stale mappings warn without blocking an unrelated default selection", (t) => {
  const root = temporaryDirectory(t);
  const current = path.join(root, "current");
  const missing = path.join(root, "missing");
  fs.mkdirSync(current);
  const selection = selectManifestProfile({
    profiles: { default: profile(), work: profile("Work") },
    projects: { [missing]: "work" },
  }, { cwd: current });
  assert.equal(selection.profileId, "default");
  assert(selection.warnings.some((warning) => warning.code === "stale-project-root"));
});

test("manifest validation rejects unsafe keys, duplicate layers, invalid labels, and Pack drift", () => {
  const polluted = JSON.parse('{"profiles":{"default":{"label":"Default","layers":[]}},"__proto__":{"polluted":true}}');
  assert.throws(() => validateContextManifest(polluted), /reserved key/);
  assert.throws(() => validateContextManifest({
    profiles: { default: profile("Default", [{ name: "same", level: 1, path: "a" }, { name: "same", level: 0, path: "b" }]) },
  }), /duplicate layer name/);
  assert.throws(() => normalizeProfileLabel("github_pat_abcdefghijklmnopqrstuvwxyz"), /credential/);
  assert.equal(createProfileId("Déjà Vu", ["deja-vu"]), "deja-vu-2");
  assert.throws(() => validateContextManifest({
    profiles: { default: profile("Default", [{ name: "repo", level: 1, source: "github", repo: "acme/docs", token: "secret" }]) },
  }), /raw credential field/);
  assert.throws(() => validateContextManifest({
    profiles: { default: profile("Default", [{ name: "repo", level: 1, source: "github", repo: "acme/docs", cache: { clientSecret: "plain" } }]) },
  }), /raw credential field/);
  assert.throws(() => validateContextManifest({
    profiles: { default: profile() },
    metadata: { endpoint: "https://example.invalid/docs?token=abcdefghijklmnop" },
  }), /looks like a raw credential/);
  assert.throws(() => validateContextManifest({
    profiles: { default: profile("Default", [{ name: "repo", level: 1, source: "github", repo: "acme/docs", auth: "ghp_not-a-reference" }]) },
  }), /keychain alias or a tokenEnv reference/);
  assert.throws(() => validateContextManifest({
    profiles: { default: profile("Default", [{ name: "remote", level: 1, source: "mcp", command: "node", args: ["--header", "Bearer abcdefghijklmnopqrstuvwxyz"] }]) },
  }), /looks like a raw credential/);

  assert.throws(() => validateContextManifest({
    profiles: {
      default: profile("Default", [{ name: "pack-demo", level: 1, path: "packs/demo/1.0.0", origin: "pack:demo@1.0.0" }]),
    },
    packs: {
      demo: {
        installedVersions: [{ version: "1.0.0", checksum: "sha256:test" }],
        assignments: [{ profile: "default", layerName: "pack-demo", activeVersion: "1.0.0", level: 0 }],
      },
    },
  }), /does not match layer/);
  assert.throws(() => validateContextManifest({
    profiles: {
      default: profile("Default", [{ name: "pack-demo", level: 0, path: "packs/demo/1.0.0", origin: "pack:demo@1.0.0" }]),
    },
    packs: {
      demo: {
        installedVersions: [{ version: "1.0.0" }],
        assignments: [
          { profile: "default", layerName: "pack-demo", activeVersion: "1.0.0", level: 0 },
          { profile: "default", layerName: "pack-demo", activeVersion: "1.0.0", level: 0 },
        ],
      },
    },
  }), /duplicate assignment/);
});

test("inactive Pack drift warns while selecting the affected profile fails closed", () => {
  const manifest = {
    profiles: {
      default: profile(),
      work: profile("Work", [{ name: "pack-demo", level: 1, path: "packs/demo/1.0.0", origin: "pack:demo@1.0.0" }]),
    },
    packs: {
      demo: {
        installedVersions: [{ version: "1.0.0" }],
        assignments: [{ profile: "work", layerName: "pack-demo", activeVersion: "1.0.0", level: 0 }],
      },
    },
  };
  assert.throws(() => validateContextManifest(manifest), /does not match layer/);
  const healthy = selectManifestProfile(manifest, { requestedProfile: "default" });
  assert.equal(healthy.profileId, "default");
  assert(healthy.warnings.some((warning) => warning.code === "pack-layer-drift" && warning.profileId === "work"));
  assert.throws(() => selectManifestProfile(manifest, { requestedProfile: "work" }), /does not match layer/);
  const summaries = listManifestProfiles(manifest);
  assert.equal(summaries.find((entry) => entry.id === "default").valid, true);
  assert.equal(summaries.find((entry) => entry.id === "work").valid, false);
});

test("transitional migration preserves runnable data, quarantines incomplete sources, and creates a verified backup", (t) => {
  const root = temporaryDirectory(t);
  const manifestPath = path.join(root, "manifest.json");
  const projectPath = path.join(root, "new-project");
  fs.mkdirSync(projectPath);
  const original = {
    layers: [
      { name: "personal", level: 3, source: "files", path: "notes" },
      { name: "pack-demo", level: 0, path: "packs/demo/1.0.0", origin: "pack:demo@1.0.0" },
    ],
    profiles: {
      default: {
        label: "Remote default",
        layers: [
          { name: "remote-mcp", level: 1, source: "mcp", command: { __scrubbed: "execution" } },
          { name: "personal", level: 3, source: "files", path: { __scrubbed: "path" } },
        ],
      },
      work: {
        label: "Work",
        layers: [
          { name: "work-docs", level: 2, source: "files", path: "work" },
          { name: "remote-files", level: 1, source: "files", path: { __scrubbed: "path" } },
        ],
      },
    },
    profilesOwnerUserId: "user-1",
    pendingSources: [
      { name: "pending", level: 1, source: "files" },
      { name: "personal", level: 3, source: "files", path: { __scrubbed: "path" } },
    ],
    pendingSourcesOwnerUserId: "user-1",
    packs: {
      demo: {
        installedVersions: [{ version: "1.0.0", checksum: "sha256:test" }],
        assignments: [{ profile: null, layerName: "pack-demo", activeVersion: "1.0.0", level: 0 }],
      },
    },
  };
  const raw = `${JSON.stringify(original, null, 2)}\n`;
  fs.writeFileSync(manifestPath, raw, { mode: 0o600 });

  const result = migrateManifestToV2(manifestPath, {
    newProfile: { id: "new-project", label: "New Project" },
    projectPath,
    now: () => new Date("2026-07-29T12:34:56.000Z"),
  });
  assert.equal(result.action, "migrated");
  assert.equal(result.backupHash, crypto.createHash("sha256").update(raw).digest("hex"));
  assert.match(result.backupPath, /\.pre-profiles\.20260729T123456Z\.[a-f0-9]{64}\.json$/);
  assert.equal(verifyManifestBackup(result.backupPath, result.backupHash), true);
  assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o600);

  const migrated = readContextManifest(manifestPath);
  assert.equal(classifyManifest(migrated), "v2");
  assert.equal(Object.hasOwn(migrated, "layers"), false);
  assert.deepEqual(migrated.profiles.default.layers, original.layers);
  assert.deepEqual(migrated.profiles.work.layers.map((layer) => layer.name), ["work-docs"]);
  assert.deepEqual(migrated.profiles.work.pendingSources.map((source) => source.name), ["remote-files"]);
  assert.deepEqual(new Set(migrated.profiles.default.pendingSources.map((source) => source.name)), new Set(["remote-mcp", "pending"]));
  assert.equal(migrated.profiles.default.pendingSourcesOwnerUserId, "user-1");
  assert.equal(migrated.profilesOwnerUserId, "user-1");
  assert.equal(migrated.packs.demo.assignments[0].profile, "default");
  assert.deepEqual(migrated.profiles["new-project"], { label: "New Project", layers: [] });
  assert.equal(migrated.projects[fs.realpathSync.native(projectPath)], "new-project");
  assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600);

  const beforeSecondRun = fs.readFileSync(manifestPath, "utf8");
  const second = migrateManifestToV2(manifestPath);
  assert.equal(second.action, "already-v2");
  assert.equal(second.backupPath, null);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), beforeSecondRun);
});

test("migration accepts the transitional profile shape emitted by desktop settings sync", (t) => {
  const root = temporaryDirectory(t);
  const manifestPath = path.join(root, "manifest.json");
  const remote = prepareSyncPayload({
    profiles: {
      default: profile("Default", [{ name: "remote-default", level: 1, source: "files", path: "/Users/remote/notes" }]),
      company: profile("Company", [{ name: "remote-mcp", level: 0, source: "mcp", command: "node", args: ["./server.mjs"] }]),
    },
  });
  const newMachine = mergeSyncedSettings({}, remote);
  assert.doesNotMatch(JSON.stringify(newMachine), /Users\/remote|server\.mjs|"node"/);
  writeContextManifest(manifestPath, {
    layers: [{ name: "local", level: 3, source: "files", path: "notes" }],
    profiles: newMachine.profiles,
    profilesOwnerUserId: "user-1",
  }, { allowTransitional: true });

  migrateManifestToV2(manifestPath);
  const migrated = readContextManifest(manifestPath);
  assert.deepEqual(migrated.profiles.default.layers.map((layer) => layer.name), ["local"]);
  assert.deepEqual(migrated.profiles.default.pendingSources.map((source) => source.name), ["remote-default"]);
  assert.deepEqual(migrated.profiles.company.layers, []);
  assert.deepEqual(migrated.profiles.company.pendingSources.map((source) => source.name), ["remote-mcp"]);
  assert.equal(migrated.profilesOwnerUserId, "user-1");
});

test("flat migration preserves every layer field and refuses a stale or corrupt backup", (t) => {
  const root = temporaryDirectory(t);
  const manifestPath = path.join(root, "manifest.json");
  const manifest = {
    layers: [
      { name: "team", level: 2, source: "files", path: "team", customAdapterOption: { keep: true } },
      { name: "live", level: 1, path: "live", live: true, git: { pullTtlSeconds: 90, retentionDays: 14 } },
    ],
  };
  const raw = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(manifestPath, raw, { mode: 0o600 });
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const backupPath = `${manifestPath}.pre-profiles.20260729T010203Z.${hash}.json`;
  fs.writeFileSync(backupPath, "corrupt", { mode: 0o600 });

  assert.throws(() => migrateManifestToV2(manifestPath, {
    newProfile: { id: "work", label: "Work" },
    now: () => new Date("2026-07-29T01:02:03.000Z"),
  }), /backup hash mismatch/i);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), raw);

  fs.rmSync(backupPath);
  migrateManifestToV2(manifestPath, {
    newProfile: { id: "work", label: "Work" },
    now: () => new Date("2026-07-29T01:02:03.000Z"),
  });
  const migrated = readContextManifest(manifestPath);
  assert.deepEqual(migrated.profiles.default.layers, manifest.layers);
  assert.deepEqual(migrated.profiles.work.layers, []);
});

test("writes reject accidental split-brain manifests unless a compatibility caller opts in", (t) => {
  const root = temporaryDirectory(t);
  const manifestPath = path.join(root, "manifest.json");
  const transitional = { layers: [], profiles: { work: profile("Work") } };
  assert.throws(() => writeContextManifest(manifestPath, transitional), /transitional manifest/);
  writeContextManifest(manifestPath, transitional, { allowTransitional: true });
  assert.equal(classifyManifest(readContextManifest(manifestPath)), "transitional");
});

test("source fingerprints and cache namespaces isolate profile, auth, and ref identity without moving legacy caches", async (t) => {
  const root = temporaryDirectory(t);
  const layer = { name: "repo", level: 1, source: "github", repo: "acme/docs", ref: "main", cache: { ttlSeconds: 60 } };
  const first = sourceConfigFingerprint("default", layer, root);
  assert.equal(first, sourceConfigFingerprint("default", structuredClone(layer), root));
  assert.notEqual(first, sourceConfigFingerprint("work", layer, root));
  assert.notEqual(first, sourceConfigFingerprint("default", { ...layer, ref: "release" }, root));
  assert.notEqual(first, sourceConfigFingerprint("default", { ...layer, auth: { tokenEnv: "PRIVATE_GITHUB_TOKEN" } }, root));

  const docsDir = path.join(root, "docs");
  fs.mkdirSync(docsDir);
  fs.writeFileSync(path.join(docsDir, "note.md"), "# Note\n\nLegacy cache location.\n");
  const sourceManifest = {
    layers: [{ name: "notes", level: 1, source: "files", path: "docs", cache: { dir: "build-cache", ttlSeconds: 60 } }],
  };
  const [legacySource] = buildSources(sourceManifest, root);
  await legacySource.loadConcept("note");
  assert(fs.existsSync(path.join(root, "build-cache", "notes", "concept%3Anote.json")));
  const [profileSource] = buildSources(sourceManifest, root, { profileId: "work" });
  await profileSource.loadConcept("note");
  const profileFingerprint = sourceConfigFingerprint("work", sourceManifest.layers[0], root);
  assert(fs.existsSync(path.join(root, "build-cache", profileFingerprint, "notes", "concept%3Anote.json")));

  const cacheDir = path.join(root, "cache");
  const makeSource = (value) => ({
    name: "same",
    level: 1,
    async loadConcept() { return value; },
    async listConceptIds() { return []; },
    close() {},
  });
  const one = withCache(makeSource({ profile: "one" }), { cacheDir, namespace: "one-fingerprint" });
  const two = withCache(makeSource({ profile: "two" }), { cacheDir, namespace: "two-fingerprint" });
  assert.deepEqual(await one.loadConcept("id"), { profile: "one" });
  assert.deepEqual(await two.loadConcept("id"), { profile: "two" });
  assert.deepEqual(fs.readdirSync(cacheDir).sort(), ["one-fingerprint", "two-fingerprint"]);

  const hostile = withCache({ ...makeSource({ safe: true }), name: ".." }, { cacheDir, namespace: ".." });
  assert.deepEqual(await hostile.loadConcept("id"), { safe: true });
  assert(fs.existsSync(path.join(cacheDir, "%2E%2E", "%2E%2E", "concept%3Aid.json")));
  assert.equal(fs.existsSync(path.join(root, "concept%3Aid.json")), false);
  hostile.sync();
  assert(fs.existsSync(path.join(cacheDir, "one-fingerprint")));
});

test("manifest mutation locking preserves concurrent updates and times out safely", async (t) => {
  const root = temporaryDirectory(t);
  const manifestPath = path.join(root, "manifest.json");
  writeContextManifest(manifestPath, { layers: [] });
  const script = `
    import { mutateContextManifest } from ${JSON.stringify(pathToFileURL(manifestModule).href)};
    const [manifestPath, label, hold] = process.argv.slice(1);
    mutateContextManifest(manifestPath, (manifest) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(hold));
      manifest.order = [...(manifest.order ?? []), label];
    });
  `;
  await Promise.all([
    runNode(script, [manifestPath, "one", "100"]),
    runNode(script, [manifestPath, "two", "0"]),
  ]);
  assert.deepEqual(new Set(readContextManifest(manifestPath).order), new Set(["one", "two"]));

  fs.writeFileSync(`${manifestPath}.lock`, "held\n", { mode: 0o600 });
  assert.throws(() => withManifestLock(manifestPath, () => {}, { timeoutMs: 25, staleMs: 60_000 }), /Timed out acquiring/);
  fs.rmSync(`${manifestPath}.lock`);

  fs.writeFileSync(`${manifestPath}.lock`, JSON.stringify({ pid: 999_999, createdAt: 1, token: "stale" }), { mode: 0o600 });
  const staleRaceScript = `
    import { withManifestLock } from ${JSON.stringify(pathToFileURL(manifestModule).href)};
    const [manifestPath] = process.argv.slice(1);
    try {
      withManifestLock(manifestPath, () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 180);
      }, { timeoutMs: 75, staleMs: 1 });
      process.stdout.write("WON");
    } catch (error) {
      process.stdout.write(error.message.includes("Timed out") ? "BUSY" : "ERROR");
    }
  `;
  const staleResults = await Promise.all([
    runNodeOutput(staleRaceScript, [manifestPath]),
    runNodeOutput(staleRaceScript, [manifestPath]),
  ]);
  assert.equal(staleResults.filter((result) => result === "WON").length, 1);
  assert.equal(staleResults.filter((result) => result === "BUSY").length, 1);

  withManifestLock(manifestPath, () => {
    fs.writeFileSync(`${manifestPath}.lock`, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "replacement" }));
  });
  assert.equal(JSON.parse(fs.readFileSync(`${manifestPath}.lock`, "utf8")).token, "replacement");
  fs.rmSync(`${manifestPath}.lock`);
});

test("concurrent source, Pack, and first-profile mutations cannot lose an update", async (t) => {
  const root = temporaryDirectory(t);
  const manifestPath = path.join(root, "manifest.json");
  const packsDir = path.join(root, "packs");
  const sourcePack = path.join(repoRoot, "specs/contextcake-packs/packs/contextcake");
  writeContextManifest(manifestPath, { layers: [] });

  const migrateScript = `
    import { migrateManifestToV2 } from ${JSON.stringify(pathToFileURL(manifestModule).href)};
    const [manifestPath] = process.argv.slice(1);
    migrateManifestToV2(manifestPath, { newProfile: { id: "work", label: "Work" } });
  `;
  const packScript = `
    import { installPack } from ${JSON.stringify(pathToFileURL(packManagerModule).href)};
    const [manifestPath, sourceRoot, packsDir] = process.argv.slice(1);
    installPack({ manifestPath, sourceRoot, packsDir });
  `;
  const sourceScript = `
    import { getManifestProfileLayers, mutateContextManifest } from ${JSON.stringify(pathToFileURL(manifestModule).href)};
    const [manifestPath] = process.argv.slice(1);
    mutateContextManifest(manifestPath, (manifest) => {
      getManifestProfileLayers(manifest).push({ name: "notes", level: 2, source: "files", path: "notes" });
    }, { allowTransitional: true });
  `;
  await Promise.all([
    runNode(migrateScript, [manifestPath]),
    runNode(packScript, [manifestPath, sourcePack, packsDir]),
    runNode(sourceScript, [manifestPath]),
  ]);

  const manifest = readContextManifest(manifestPath);
  assert.equal(classifyManifest(manifest), "v2");
  assert.deepEqual(manifest.profiles.work, { label: "Work", layers: [] });
  assert(manifest.profiles.default.layers.some((layer) => layer.origin === "pack:contextcake@0.1.0"));
  assert(manifest.profiles.default.layers.some((layer) => layer.name === "notes"));
  assert.equal(manifest.packs.contextcake.assignments[0].profile, "default");
});

test("profile summaries and revisions are deterministic without opening sources", () => {
  const manifest = {
    profiles: {
      default: profile(),
      work: { label: "Work", layers: [], pendingSources: [{ name: "remote" }] },
    },
    projects: { "/tmp/work": "work" },
  };
  const summaries = listManifestProfiles(manifest);
  assert.equal(summaries.find((entry) => entry.id === "work").mappingCount, 1);
  assert.equal(summaries.find((entry) => entry.id === "work").pendingSourceCount, 1);
  assert.equal(summaries.find((entry) => entry.id === "work").valid, true);
  assert(selectManifestProfile(manifest, { requestedProfile: "work" }).warnings.some((warning) => warning.code === "pending-source"));
  assert.equal(manifestRevision(manifest), manifestRevision(structuredClone(manifest)));
  assert.notEqual(manifestRevision(manifest), manifestRevision({ ...manifest, projects: {} }));
});

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited ${code}: ${stderr}`));
    });
  });
}

function runNodeOutput(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`child exited ${code}: ${stderr}`));
    });
  });
}
