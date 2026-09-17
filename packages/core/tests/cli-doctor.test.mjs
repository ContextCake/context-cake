// `contextcake doctor` (control-plane spec §5.2 exit 8, §5.11, §5.12;
// specs/local-diagnostics/spec.md): manifest, profile, source reachability as
// coverage, config/data/cache directories, every `contextcake` on PATH with
// its version, fix commands that exist in this build, and the observability
// hook the Mac app's CLI passes in.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildTable, defineFamily } from "../src/cli/table.mjs";
import { FAMILIES } from "../src/cli/families/index.mjs";
import { cliHome, runContextcake, writeManifest } from "./helpers/cli-harness.mjs";

const posixOnly = { skip: process.platform === "win32" ? "fake executables are POSIX shell scripts" : false };
const DOCTOR_ENTRY = fileURLToPath(new URL("../src/doctor.mjs", import.meta.url));

// A PATH directory holding a `contextcake` that prints `version`.
async function fakeInstall(home, name, version) {
  const dir = path.join(home.dir, name);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "contextcake");
  await fs.writeFile(file, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  return dir;
}

async function healthyHome(t) {
  const home = await cliHome(t);
  const notes = path.join(home.dir, "notes");
  await fs.mkdir(notes);
  await writeManifest(home, { profiles: { default: { label: "Default", layers: [{ name: "notes", source: "files", path: notes, level: 1 }] } } });
  return home;
}

test("a healthy setup exits 0 with the report, coverage, and the install on PATH", posixOnly, async (t) => {
  const home = await healthyHome(t);
  const bin = await fakeInstall(home, "bin", "0.0.0-test");
  const result = await runContextcake(["doctor", "--json"], home, { env: { PATH: bin } });
  assert.equal(result.exitCode, 0, result.stdout);
  const { data } = result.json;
  assert.equal(data.healthy, true);
  assert.equal(data.scope, "fresh-configuration-check");
  assert.equal(data.manifest.status, "valid");
  assert.deepEqual(data.profile, { id: "default", label: "Default", reason: "default", mode: "v2" });
  assert.deepEqual(data.sources.map((row) => [row.name, row.status]), [["notes", "present"]]);
  assert.deepEqual(data.directories.map((row) => [row.name, row.writable]), [["config", true], ["data", true], ["cache", true]]);
  assert.deepEqual(data.executables.map((row) => [row.path, row.version]), [[path.join(bin, "contextcake"), "0.0.0-test"]]);
  assert.equal(data.cli.version, "0.0.0-test");
  assert.equal(data.observability.state, "not-checked");
  assert.ok(data.settings.maxDocFiles > 0);
  assert.deepEqual(result.json.coverage, { complete: true, sources: [{ name: "notes", kind: "files", status: "ok" }], degraded: [] });
  assert.deepEqual(result.json.warnings, []);
  assert.equal(result.json.context.profileId, "default");
  assert.match(result.json.context.manifestRevision, /^sha256:[a-f0-9]{64}$/);

  const text = await runContextcake(["doctor"], home, { env: { PATH: bin } });
  assert.equal(text.exitCode, 0);
  assert.match(text.stdout, /^ContextCake doctor: checks completed/);
  assert.match(text.stdout, /ok {4}notes \(files\): present\./);
});

test("more than one install, or a different version first on PATH, is a warning", posixOnly, async (t) => {
  const home = await healthyHome(t);
  const older = await fakeInstall(home, "older", "0.5.0");
  const current = await fakeInstall(home, "current", "0.0.0-test");
  const result = await runContextcake(["doctor", "--json"], home, { env: { PATH: [older, current].join(path.delimiter) } });
  assert.equal(result.exitCode, 0, result.stdout);
  assert.deepEqual(result.json.data.executables.map((row) => row.version), ["0.5.0", "0.0.0-test"]);
  const codes = result.json.warnings.map((warning) => warning.code).sort();
  assert.deepEqual(codes, ["MULTIPLE_EXECUTABLES", "PATH_VERSION_MISMATCH"]);
  const mismatch = result.json.warnings.find((warning) => warning.code === "PATH_VERSION_MISMATCH");
  assert.deepEqual(mismatch.details, { path: path.join(older, "contextcake"), pathVersion: "0.5.0", runningVersion: "0.0.0-test" });

  // One install reached through two PATH entries is not two installs.
  const linked = path.join(home.dir, "linked");
  await fs.mkdir(linked);
  await fs.symlink(path.join(current, "contextcake"), path.join(linked, "contextcake"));
  const same = await runContextcake(["doctor", "--json"], home, { env: { PATH: [current, linked].join(path.delimiter) } });
  assert.equal(same.json.data.executables.length, 2);
  assert.deepEqual(same.json.warnings, []);
});

test("no manifest exits 8 with the report in error.details and suggests init", async (t) => {
  const home = await cliHome(t);
  const result = await runContextcake(["doctor", "--json"], home, { env: { PATH: "" } });
  assert.equal(result.exitCode, 8, result.stdout);
  assert.equal(result.json.error.code, "UNHEALTHY_DIAGNOSTICS");
  assert.equal(result.json.error.category, "unhealthy");
  assert.equal(result.json.error.details.manifest.status, "missing");
  assert.equal(result.json.error.details.profile, null);
  assert.deepEqual(result.json.nextActions.map((action) => action.run), ["contextcake init"]);

  const text = await runContextcake(["doctor"], home, { env: { PATH: "" } });
  assert.equal(text.exitCode, 8);
  assert.match(text.stdout, /needs attention/);
  assert.match(text.stdout, /FAIL {2}No manifest at /);
});

test("a missing folder or an invalid layer is unhealthy; an MCP source is not started", async (t) => {
  const home = await healthyHome(t);
  const manifest = JSON.parse(await fs.readFile(home.manifestPath, "utf8"));
  manifest.profiles.default.layers.push(
    { name: "gone", source: "files", path: path.join(home.dir, "absent"), level: 2 },
    { name: "foreign", source: "mcp", command: path.join(home.dir, "never-run"), args: [], level: 3 },
  );
  await writeManifest(home, manifest);
  const missingFolder = await runContextcake(["doctor", "--json"], home, { env: { PATH: "" } });
  assert.equal(missingFolder.exitCode, 8, missingFolder.stdout);
  const details = missingFolder.json.error.details;
  assert.deepEqual(details.sources.map((row) => [row.name, row.status]), [["notes", "present"], ["gone", "unavailable"], ["foreign", "not-probed"]]);
  assert.deepEqual(details.coverage.degraded.map((row) => row.source), ["gone", "foreign"]);
  assert.ok(missingFolder.json.warnings.some((warning) => warning.code === "SOURCE_NOT_PROBED"));

  // The MCP source alone: healthy, but coverage cannot be complete.
  manifest.profiles.default.layers = manifest.profiles.default.layers.filter((layer) => layer.name !== "gone");
  await writeManifest(home, manifest);
  const notProbed = await runContextcake(["doctor", "--json"], home, { env: { PATH: "" } });
  assert.equal(notProbed.exitCode, 0, notProbed.stdout);
  assert.equal(notProbed.json.coverage.complete, false);
  const strict = await runContextcake(["doctor", "--require-complete", "--json"], home, { env: { PATH: "" } });
  assert.equal(strict.exitCode, 6);

  manifest.profiles.default.layers.push({ name: "broken", source: "no-such-kind", path: "x", level: 0 });
  await writeManifest(home, manifest);
  const quarantined = await runContextcake(["doctor", "--json"], home, { env: { PATH: "" } });
  assert.equal(quarantined.exitCode, 8);
  assert.equal(quarantined.json.error.details.manifest.status, "quarantined");
  assert.deepEqual(quarantined.json.error.details.manifest.quarantined.map((row) => row.name), ["broken"]);
});

test("an unknown profile is unhealthy and suggests profile list", async (t) => {
  const home = await healthyHome(t);
  const result = await runContextcake(["doctor", "--profile", "nope", "--json"], home, { env: { PATH: "" } });
  assert.equal(result.exitCode, 8, result.stdout);
  assert.ok(result.json.nextActions.some((action) => action.command === "profile.list"));
});

test("fix commands are suggested only when this build has them", async (t) => {
  const home = await cliHome(t);
  const notes = path.join(home.dir, "notes");
  await writeManifest(home, { profiles: { default: { label: "Default", layers: [{ name: "notes", source: "files", path: notes, level: 1 }] } } });
  const withoutSource = await runContextcake(["doctor", "--json"], home, { env: { PATH: "" } });
  assert.equal(withoutSource.exitCode, 8);
  assert.ok(!withoutSource.json.nextActions.some((action) => action.command.startsWith("source.")));

  // A build with a source family gets the concrete commands.
  const source = defineFamily({
    name: "source",
    stability: "experimental",
    summary: "stand-in",
    commands: ["update", "remove", "test", "add"].map((name) => ({ name, summary: name, mutation: "read", run: () => ({ data: null }) })),
  });
  const table = buildTable([...FAMILIES, source]);
  const withSource = await runContextcake(["doctor", "--json"], home, { env: { PATH: "" }, table });
  assert.deepEqual(withSource.json.nextActions.map((action) => action.run), [
    "contextcake source update notes --path <folder>",
    "contextcake source remove notes",
  ]);
});

test("an unwritable data directory is unhealthy", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "needs POSIX permissions as a non-root user" : false }, async (t) => {
  const home = await healthyHome(t);
  const locked = path.join(home.dir, "locked");
  await fs.mkdir(locked, { mode: 0o555 });
  t.after(() => fs.chmod(locked, 0o755).catch(() => {}));
  const result = await runContextcake(["doctor", "--json"], home, { env: { PATH: "", CONTEXTCAKE_DATA_DIR: path.join(locked, "data") } });
  assert.equal(result.exitCode, 8, result.stdout);
  const data = result.json.error.details.directories.find((row) => row.name === "data");
  assert.equal(data.writable, false);
});

test("the app's wrapSpawn hook adds the observability check", async (t) => {
  const home = await healthyHome(t);
  // Stands in for apps/desktop/src/observability/doctor-launcher.mjs.
  const launcher = path.join(home.dir, "launcher.mjs");
  await fs.writeFile(launcher, [
    "import { pathToFileURL } from 'node:url'",
    "const [entry] = process.argv.slice(2)",
    "const { main } = await import(pathToFileURL(entry).href)",
    "await main({ observability: { state: 'available', scope: 'fresh-local-check' } })",
  ].join("\n"));
  const calls = [];
  const wrapSpawn = (call) => {
    calls.push(call);
    return { args: [launcher, call.entry, path.join(call.paths.config, "local-observability.json"), ...call.args], env: call.env };
  };
  const result = await runContextcake(["doctor", "--json"], home, { env: { PATH: "" }, wrapSpawn });
  assert.equal(result.exitCode, 0, result.stdout);
  assert.deepEqual(result.json.data.observability, { state: "available", scope: "fresh-local-check" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "doctor");
  assert.equal(calls[0].entry, DOCTOR_ENTRY);

  const broken = await runContextcake(["doctor", "--json"], home, { env: { PATH: "" }, wrapSpawn: () => ({ args: ["-e", "process.exit(3)"], env: {} }) });
  assert.equal(broken.exitCode, 0, "an observability failure is reported, not fatal");
  assert.equal(broken.json.data.observability.state, "unavailable");
});
