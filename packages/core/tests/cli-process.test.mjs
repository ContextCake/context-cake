// What only a real process shows: SIGINT delivery, a stalled command that
// must still exit, and the write path of a spawned entrypoint. Each test runs
// main() in a child with a small throwaway table.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = new URL("../src/cli.mjs", import.meta.url).href;
const TABLE_MODULE = new URL("../src/cli/table.mjs", import.meta.url).href;
const ENGINE_CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

async function tempDir(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cc-cli-process-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// A read that never finishes on its own (an interval keeps the process
// alive) and records when ctx.signal aborts; a write that takes 600ms and
// records when it lands.
async function writeFixture(dir) {
  const file = path.join(dir, "fixture.mjs");
  await fs.writeFile(file, `
    import fs from "node:fs";
    import path from "node:path";
    import { main } from ${JSON.stringify(CLI)};
    import { buildTable, defineFamily } from ${JSON.stringify(TABLE_MODULE)};
    const dir = ${JSON.stringify(dir)};
    const slow = defineFamily({
      name: "slow",
      stability: "experimental",
      summary: "slow",
      commands: [
        {
          name: "read",
          summary: "read",
          mutation: "read",
          run(ctx) {
            setInterval(() => {}, 1000);
            ctx.signal.addEventListener("abort", () => fs.writeFileSync(path.join(dir, "aborted"), String(ctx.signal.reason?.code)));
            fs.writeFileSync(path.join(dir, "started"), "");
            return new Promise(() => {});
          },
        },
        {
          name: "write",
          summary: "write",
          mutation: "write",
          async run() {
            fs.writeFileSync(path.join(dir, "started"), "");
            await new Promise((resolve) => setTimeout(resolve, 600));
            fs.writeFileSync(path.join(dir, "written"), "");
            return { data: { written: true } };
          },
        },
      ],
    });
    await main(process.argv.slice(2), { table: buildTable([slow]) });
  `);
  return file;
}

function run(file, args, { signalAfterStart = null, dir, env = process.env } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [file, ...args], { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    let poll = null;
    if (signalAfterStart) {
      poll = setInterval(async () => {
        try {
          await fs.access(path.join(dir, "started"));
          clearInterval(poll);
          setTimeout(() => child.kill(signalAfterStart.signal), signalAfterStart.ms);
        } catch { /* not yet */ }
      }, 10);
    }
    child.on("exit", (code, signal) => {
      clearTimeout(killer);
      clearInterval(poll);
      resolve({ code, signal, stdout, stderr, ms: Date.now() - started });
    });
  });
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

test("--timeout aborts ctx.signal, answers TIMEOUT, and the process exits", async (t) => {
  const dir = await tempDir(t);
  const file = await writeFixture(dir);
  const result = await run(file, ["slow", "read", "--timeout", "200", "--json"], { dir });
  assert.equal(result.code, 6, result.stderr);
  assert.ok(result.ms < 5000, `exited after ${result.ms}ms`);
  assert.equal(JSON.parse(result.stdout).error.code, "TIMEOUT");
  assert.equal(await fs.readFile(path.join(dir, "aborted"), "utf8"), "TIMEOUT");
});

test("SIGINT during a read answers INTERRUPTED with 130 and the process exits", { skip: process.platform === "win32" }, async (t) => {
  const dir = await tempDir(t);
  const file = await writeFixture(dir);
  const result = await run(file, ["slow", "read", "--json"], { dir, signalAfterStart: { signal: "SIGINT", ms: 100 } });
  assert.equal(result.code, 130, result.stderr);
  assert.ok(result.ms < 5000, `exited after ${result.ms}ms`);
  assert.equal(JSON.parse(result.stdout).error.code, "INTERRUPTED");
  assert.equal(await fs.readFile(path.join(dir, "aborted"), "utf8"), "INTERRUPTED");
});

test("SIGINT during a write lets the write land and reports it", { skip: process.platform === "win32" }, async (t) => {
  const dir = await tempDir(t);
  const file = await writeFixture(dir);
  const result = await run(file, ["slow", "write", "--json"], { dir, signalAfterStart: { signal: "SIGINT", ms: 250 } });
  assert.equal(await exists(path.join(dir, "written")), true);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true, result.stdout);
  assert.equal(result.code, 0);
});

test("contextcake write --json --dry-run is refused before write.mjs can run", async (t) => {
  const dir = await tempDir(t);
  const layer = path.join(dir, "team");
  await fs.mkdir(layer);
  const manifest = path.join(dir, "manifest.json");
  await fs.writeFile(manifest, JSON.stringify({ layers: [{ name: "team", source: "okf-local", path: layer, level: 2 }] }));
  const signals = path.join(dir, "signals.json");
  await fs.writeFile(signals, JSON.stringify({
    signals: [{ id: "s1", route: "team_candidate", destination: "decisions/primary-db", title: "Primary database", summary: "Use Postgres.", repo: "app", kind: "decision" }],
  }));
  // Without --json the same dry run writes nothing, which proves the fixture
  // would write if the flag were swallowed as --json's "value".
  const control = await run(ENGINE_CLI, ["write", "--signals", signals, "--manifest", manifest, "--dry-run"], { dir });
  assert.equal(control.code, 0, control.stderr);
  assert.deepEqual(await fs.readdir(layer, { recursive: true }), []);
  const result = await run(ENGINE_CLI, ["write", "--signals", signals, "--manifest", manifest, "--json", "--dry-run"], { dir });
  assert.equal(result.code, 2, result.stdout + result.stderr);
  const files = await fs.readdir(layer, { recursive: true });
  assert.deepEqual(files, [], "nothing may be written");
});
