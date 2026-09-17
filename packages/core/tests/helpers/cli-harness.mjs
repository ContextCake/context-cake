// In-process harness for `contextcake` tests. Runs the real dispatcher with
// captured streams and an isolated config directory, so a family test needs
// no child process and never touches the developer's own manifest.
//
//   const home = await cliHome(t);                  // temp config dir + env
//   const r = await runContextcake(["init", "--json"], home);
//   assert.equal(r.exitCode, 0);
//   assert.equal(r.json.data.created, true);
//
// With --json, `json` is the parsed envelope and the harness has already
// asserted the stdout contract: exactly one JSON document, nothing else, and
// on failure an error code the command declares in its `errors`.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TABLE, runCli } from "../../src/cli.mjs";
import { resolveCommand } from "../../src/cli/table.mjs";

function capture() {
  let text = "";
  return {
    write(chunk) {
      text += chunk;
      return true;
    },
    get text() {
      return text;
    },
  };
}

export async function cliHome(t, prefix = "cc-cli-") {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, "config");
  return {
    dir,
    config,
    manifestPath: path.join(config, "manifest.json"),
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      CONTEXTCAKE_CONFIG_DIR: config,
      CONTEXTCAKE_DATA_DIR: path.join(dir, "data"),
      CONTEXTCAKE_CACHE_DIR: path.join(dir, "cache"),
    },
  };
}

export async function writeManifest(home, manifest) {
  await fs.mkdir(path.dirname(home.manifestPath), { recursive: true });
  await fs.writeFile(home.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return home.manifestPath;
}

// options: env (merged over home.env), cwd, and any runCli option (table,
// secrets, wrapSpawn, interrupt).
export async function runContextcake(argv, home, { env = {}, cwd = home.cwd, ...options } = {}) {
  const stdout = capture();
  const stderr = capture();
  const { exitCode, signal } = await runCli(argv, {
    version: "0.0.0-test",
    ...options,
    env: { ...home.env, ...env },
    cwd,
    stdout,
    stderr,
  });
  let json = null;
  if (argv.includes("--json") && !argv.includes("--help") && argv[0] !== "mcp") {
    const lines = stdout.text.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, `--json must print exactly one document; got:\n${stdout.text}`);
    json = JSON.parse(lines[0]);
    assert.equal(json.schemaVersion, 1);
    assert.equal(typeof json.ok, "boolean");
    assert.ok(Array.isArray(json.warnings) && Array.isArray(json.nextActions));
    if (!json.ok) {
      assert.equal(json.data, null);
      assert.equal(json.error.exitCode, exitCode, "envelope exitCode must match the process exit code");
      // help --json promises a command's possible error codes; an undeclared
      // code reaching an agent is a contract bug, caught here in every test.
      const { command } = resolveCommand(options.table ?? TABLE, argv);
      if (command?.run) {
        assert.ok(command.errors.includes(json.error.code), `${command.id} answered ${json.error.code}, which it does not declare in errors`);
      }
    }
  }
  return { exitCode, signal, stdout: stdout.text, stderr: stderr.text, json };
}
