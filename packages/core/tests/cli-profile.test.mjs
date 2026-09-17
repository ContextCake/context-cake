// `contextcake init` and the profile family (control-plane spec §5.3, §5.13).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EMPTY_V2_MANIFEST } from "../src/cli/families/init.mjs";
import { manifestRevisionOf } from "../src/cli/context.mjs";
import { readContextManifest, selectManifestProfile } from "../src/manifest.mjs";
import { sidecarDir, sidecarRoot } from "../src/sidecar-state.mjs";
import { cliHome, runContextcake, writeManifest } from "./helpers/cli-harness.mjs";

const PROFILE_CLI = fileURLToPath(new URL("../src/profile-cli.mjs", import.meta.url));

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function v2Home(t, profiles = {}) {
  const home = await cliHome(t);
  const notes = path.join(home.dir, "notes");
  await fs.mkdir(notes);
  await writeManifest(home, {
    profiles: {
      default: { label: "Default", layers: [{ name: "notes", source: "files", path: notes, level: 1 }] },
      ...profiles,
    },
  });
  return { ...home, notes };
}

test("init creates a v2 manifest at the platform path and is idempotent", async (t) => {
  const home = await cliHome(t);
  const first = await runContextcake(["init", "--json"], home);
  assert.equal(first.exitCode, 0);
  assert.deepEqual(first.json.data, { manifestPath: home.manifestPath, created: true, mode: "v2" });
  assert.deepEqual(await readJson(home.manifestPath), EMPTY_V2_MANIFEST);
  assert.equal(first.json.context.manifestRevision, manifestRevisionOf(EMPTY_V2_MANIFEST));
  assert.equal(first.json.context.profileId, "default");
  const mode = (await fs.stat(home.manifestPath)).mode & 0o777;
  if (process.platform !== "win32") assert.equal(mode, 0o600);
  assert.ok(first.json.nextActions.some((action) => action.command === "mcp"));

  const bytes = await fs.readFile(home.manifestPath);
  const second = await runContextcake(["init", "--json"], home);
  assert.equal(second.exitCode, 0);
  assert.equal(second.json.data.created, false);
  assert.deepEqual(await fs.readFile(home.manifestPath), bytes);

  // The v2 manifest init wrote is readable and selects the default profile.
  const selection = selectManifestProfile(readContextManifest(home.manifestPath), { cwd: home.dir });
  assert.equal(selection.profileId, "default");
});

test("init honors --manifest relative to the working directory", async (t) => {
  const home = await cliHome(t);
  const result = await runContextcake(["init", "--manifest", "nested/custom.json", "--json"], home);
  assert.equal(result.exitCode, 0);
  assert.equal(result.json.data.manifestPath, path.join(home.dir, "nested", "custom.json"));
  await fs.access(path.join(home.dir, "nested", "custom.json"));
  await assert.rejects(fs.access(home.manifestPath));
});

test("init never migrates or overwrites an existing manifest", async (t) => {
  const home = await cliHome(t);
  await fs.mkdir(home.config, { recursive: true });
  const legacy = `${JSON.stringify({ layers: [] })}\n`;
  await fs.writeFile(home.manifestPath, legacy);
  const kept = await runContextcake(["init", "--json"], home);
  assert.equal(kept.exitCode, 0);
  assert.equal(kept.json.data.mode, "legacy");
  assert.equal(kept.json.data.created, false);
  assert.equal(kept.json.warnings[0].code, "MANIFEST_NOT_V2");
  assert.ok(kept.json.nextActions.some((action) => action.command === "profile.create"));
  assert.equal(await fs.readFile(home.manifestPath, "utf8"), legacy);

  await fs.writeFile(home.manifestPath, "{ not json");
  const broken = await runContextcake(["init", "--json"], home);
  assert.equal(broken.exitCode, 7);
  assert.equal(broken.json.error.code, "MANIFEST_INVALID");
  assert.equal(await fs.readFile(home.manifestPath, "utf8"), "{ not json");
});

test("the original profile commands print what profile-cli.mjs prints", async (t) => {
  const home = await v2Home(t, { work: { label: "Work", layers: [] } });
  const project = path.join(home.dir, "project");
  await fs.mkdir(path.join(project, "nested"), { recursive: true });
  const raw = (...args) => spawnSync(process.execPath, [PROFILE_CLI, ...args, "--manifest", home.manifestPath], { cwd: path.join(project, "nested"), encoding: "utf8" });

  const mapped = await runContextcake(["profile", "map", "work", project], home);
  assert.equal(mapped.exitCode, 0);
  assert.equal(mapped.stdout.trim(), `Mapped ${project} -> work`);

  for (const args of [["list"], ["current"]]) {
    const ours = await runContextcake(["profile", ...args], home, { cwd: path.join(project, "nested") });
    const theirs = raw(...args);
    assert.equal(theirs.status, 0, theirs.stderr);
    assert.equal(ours.stdout, theirs.stdout, args.join(" "));
    const json = await runContextcake(["profile", ...args, "--json"], home, { cwd: path.join(project, "nested") });
    assert.deepEqual(json.json.data, JSON.parse(raw(...args, "--json").stdout), `${args} --json data`);
  }
  const current = await runContextcake(["profile", "current", "--json"], home, { cwd: path.join(project, "nested") });
  assert.equal(current.json.data.reason, "project");
  assert.equal(current.json.context.profileId, "work");
  const viaCwd = await runContextcake(["profile", "current", "--cwd", path.join(project, "nested"), "--json"], home);
  assert.equal(viaCwd.json.data.id, "work");
  const explicit = await runContextcake(["profile", "current", "--profile", "default", "--cwd", project, "--json"], home);
  assert.equal(explicit.json.data.reason, "explicit");

  const unmapped = await runContextcake(["profile", "unmap", project, "--json"], home);
  assert.equal(unmapped.json.data.unmapped, project);
  const again = await runContextcake(["profile", "unmap", project, "--json"], home);
  assert.equal(again.exitCode, 3);
  assert.equal(again.json.error.code, "MAPPING_NOT_FOUND");
});

test("profile create migrates a legacy manifest with a verified backup", async (t) => {
  const home = await cliHome(t);
  await writeManifest(home, { layers: [] });
  const created = await runContextcake(["profile", "create", "Client", "Work", "--json"], home);
  assert.equal(created.exitCode, 0);
  assert.equal(created.json.data.created, "client-work");
  assert.equal(created.json.data.action, "migrated");
  await fs.access(created.json.data.backupPath);
  assert.equal(created.json.context.manifestRevision, manifestRevisionOf(await readJson(home.manifestPath)));
});

test("profile show reports sources, pending sources, mappings, and state without opening adapters", async (t) => {
  const home = await v2Home(t);
  const project = path.join(home.dir, "project");
  await fs.mkdir(project);
  const manifest = await readJson(home.manifestPath);
  manifest.profiles.default.pendingSources = [{ name: "synced", source: "files", path: { __scrubbed: "path" } }];
  manifest.projects = { [project]: "default" };
  await writeManifest(home, manifest);
  await fs.mkdir(sidecarDir(home.manifestPath, "default"), { recursive: true });

  const shown = await runContextcake(["profile", "show", "--json"], home);
  assert.equal(shown.exitCode, 0);
  assert.equal(shown.json.data.id, "default");
  assert.deepEqual(shown.json.data.sources, [{ name: "notes", kind: "files", level: 1 }]);
  assert.deepEqual(shown.json.data.pendingSources, [{ name: "synced", kind: "files" }]);
  assert.deepEqual(shown.json.data.projects, [project]);
  assert.deepEqual(shown.json.data.state, { dir: sidecarDir(home.manifestPath, "default"), exists: true });
  const missing = await runContextcake(["profile", "show", "nope", "--json"], home);
  assert.equal(missing.exitCode, 3);
  assert.equal(missing.json.error.code, "PROFILE_NOT_FOUND");
});

test("profile rename changes the label and never the id", async (t) => {
  const home = await v2Home(t, { work: { label: "Work", layers: [] } });
  const renamed = await runContextcake(["profile", "rename", "work", "Day", "Job", "--json"], home);
  assert.equal(renamed.exitCode, 0);
  assert.deepEqual(renamed.json.data, { id: "work", label: "Day Job", previousLabel: "Work" });
  const manifest = await readJson(home.manifestPath);
  assert.equal(manifest.profiles.work.label, "Day Job");
  assert.deepEqual(Object.keys(manifest.profiles).sort(), ["default", "work"]);

  const credentialShaped = await runContextcake(["profile", "rename", "work", ["gh", "p_", "label"].join(""), "--json"], home);
  assert.equal(credentialShaped.exitCode, 2);
  assert.equal(credentialShaped.json.error.code, "INVALID_INPUT");

  const legacy = await cliHome(t);
  await writeManifest(legacy, { layers: [] });
  const refused = await runContextcake(["profile", "rename", "default", "X", "--json"], legacy);
  assert.equal(refused.exitCode, 4);
  assert.equal(refused.json.error.code, "MANIFEST_NOT_V2");
});

test("profile clone copies configuration and turns MCP sources into pending ones", async (t) => {
  const home = await v2Home(t);
  const pack = path.join(home.dir, "pack");
  await fs.mkdir(pack);
  const manifest = await readJson(home.manifestPath);
  manifest.profiles.default.layers.push(
    { name: "graph", source: "mcp", command: "/usr/bin/true", args: ["--serve"], level: 2 },
    { name: "packed", source: "okf-local", path: pack, level: 3, origin: "pack:demo@1.0.0" },
  );
  manifest.packs = { demo: { id: "demo", installedVersions: [{ version: "1.0.0" }], assignments: [{ profile: "default", layerName: "packed", activeVersion: "1.0.0", level: 3 }] } };
  manifest.projects = { [home.dir]: "default" };
  await writeManifest(home, manifest);
  const before = await readJson(home.manifestPath);

  const cloned = await runContextcake(["profile", "clone", "default", "Copy", "--json"], home);
  assert.equal(cloned.exitCode, 0, cloned.stdout);
  assert.deepEqual(cloned.json.data, { created: "copy", label: "Copy", from: "default", sourceCount: 2, pendingExecutables: ["graph"] });
  assert.equal(cloned.json.warnings[0].code, "MCP_SOURCES_PENDING");

  const after = readContextManifest(home.manifestPath); // strict: pack assignments must line up
  assert.deepEqual(after.profiles.default, before.profiles.default, "the source profile is untouched");
  assert.deepEqual(after.profiles.copy.layers.map((layer) => layer.name), ["notes", "packed"]);
  const [pending] = after.profiles.copy.pendingSources;
  assert.equal(pending.name, "graph");
  assert.deepEqual(pending.command, { __scrubbed: "execution" });
  assert.deepEqual(pending.args, { __scrubbed: "execution" });
  assert.ok(after.packs.demo.assignments.some((assignment) => assignment.profile === "copy"));
  assert.deepEqual(after.projects, { [home.dir]: "default" }, "mappings are not copied");
  const selection = selectManifestProfile(after, { requestedProfile: "copy" });
  assert.ok(!selection.layers.some((layer) => layer.source === "mcp"), "the clone can run nothing");
});

test("profile delete previews, retires state, and honors the expected revision", async (t) => {
  const home = await v2Home(t, { work: { label: "Work", layers: [] } });
  const state = sidecarDir(home.manifestPath, "work");
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, "discrepancy-rules.json"), "{}\n");

  const preview = await runContextcake(["profile", "delete", "work", "--json"], home);
  assert.equal(preview.exitCode, 4);
  assert.equal(preview.json.error.code, "CONFIRMATION_REQUIRED");
  assert.equal(preview.json.error.details.profileId, "work");
  const human = await runContextcake(["profile", "delete", "work"], home);
  assert.equal(human.exitCode, 4);
  assert.match(human.stdout, /Re-run with --confirm/);

  const stale = await runContextcake(["profile", "delete", "work", "--confirm", "--expect-revision", `sha256:${"0".repeat(64)}`, "--json"], home);
  assert.equal(stale.exitCode, 4);
  assert.equal(stale.json.error.code, "STALE_REVISION");
  assert.ok((await readJson(home.manifestPath)).profiles.work, "a stale revision changes nothing");
  await fs.access(state);

  const malformed = await runContextcake(["profile", "delete", "work", "--confirm", "--expect-revision", "abc", "--json"], home);
  assert.equal(malformed.exitCode, 2);

  const revision = preview.json.context.manifestRevision;
  const deleted = await runContextcake(["profile", "delete", "work", "--confirm", "--expect-revision", revision, "--json"], home);
  assert.equal(deleted.exitCode, 0, deleted.stdout);
  assert.equal(deleted.json.data.deleted, true);
  assert.ok(deleted.json.data.retiredState.startsWith(path.join(sidecarRoot(home.manifestPath), "retired", "work@")));
  await fs.access(path.join(deleted.json.data.retiredState, "discrepancy-rules.json"));
  await assert.rejects(fs.access(state));
  assert.equal(deleted.json.context.manifestRevision, manifestRevisionOf(await readJson(home.manifestPath)));
  assert.ok(deleted.json.nextActions.some((action) => action.command === "profile.purge-state"));

  const protectedDefault = await runContextcake(["profile", "delete", "default", "--confirm", "--json"], home);
  assert.equal(protectedDefault.exitCode, 4);
  assert.equal(protectedDefault.json.error.code, "PROFILE_PROTECTED");
});

test("profile purge-state is the destructive step, and only for profiles that are gone", async (t) => {
  const home = await v2Home(t, { work: { label: "Work", layers: [] }, workshop: { label: "Workshop", layers: [] } });
  await fs.mkdir(sidecarDir(home.manifestPath, "work"), { recursive: true });
  await fs.mkdir(sidecarDir(home.manifestPath, "workshop"), { recursive: true });

  const active = await runContextcake(["profile", "purge-state", "work", "--confirm", "--json"], home);
  assert.equal(active.exitCode, 4);
  assert.equal(active.json.error.code, "PROFILE_ACTIVE");
  const defaultProfile = await runContextcake(["profile", "purge-state", "default", "--confirm", "--json"], home);
  assert.equal(defaultProfile.json.error.code, "PROFILE_ACTIVE");

  const deleted = await runContextcake(["profile", "delete", "work", "--confirm", "--json"], home);
  const listed = await runContextcake(["profile", "purge-state", "work", "--json"], home);
  assert.equal(listed.exitCode, 4);
  assert.equal(listed.json.error.code, "CONFIRMATION_REQUIRED");
  assert.deepEqual(listed.json.error.details.dirs, [deleted.json.data.retiredState]);
  await fs.access(deleted.json.data.retiredState);

  const purged = await runContextcake(["profile", "purge-state", "work", "--confirm", "--json"], home);
  assert.equal(purged.exitCode, 0);
  assert.equal(purged.json.data.purged, true);
  await assert.rejects(fs.access(deleted.json.data.retiredState));
  // A profile whose id merely starts with "work" keeps its state.
  await fs.access(sidecarDir(home.manifestPath, "workshop"));

  const nothing = await runContextcake(["profile", "purge-state", "work", "--json"], home);
  assert.equal(nothing.exitCode, 0);
  assert.deepEqual(nothing.json.data.dirs, []);
});

test("raw profile-cli.mjs delete also retires state and keeps exit 2 for the preview", async (t) => {
  const home = await v2Home(t, { work: { label: "Work", layers: [] } });
  await fs.mkdir(sidecarDir(home.manifestPath, "work"), { recursive: true });
  const preview = spawnSync(process.execPath, [PROFILE_CLI, "delete", "work", "--manifest", home.manifestPath], { encoding: "utf8" });
  assert.equal(preview.status, 2);
  const confirmed = spawnSync(process.execPath, [PROFILE_CLI, "delete", "work", "--manifest", home.manifestPath, "--confirm", "--json"], { encoding: "utf8" });
  assert.equal(confirmed.status, 0, confirmed.stderr);
  const body = JSON.parse(confirmed.stdout);
  assert.equal(body.deleted, true);
  await fs.access(body.retiredState);
});
