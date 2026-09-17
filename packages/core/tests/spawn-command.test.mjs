// How the engine launches a foreign MCP server's command on each OS
// (specs/contextcake-control-plane/spec.md §5.6: one spawn policy for the app
// and the CLI).
//
// On Windows `npx`, `pnpm`, and `yarn` are `.cmd` shims. Node refuses to spawn
// a batch file without a shell (CVE-2024-27980), so an npx-style source never
// started. Going through cmd.exe fixes that and opens a command-injection door
// if an argument is quoted wrong, so most of this file is hostile arguments.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSpawnCommand } from "../src/spawn-command.mjs";

// Windows file names are case-insensitive, so the fake disk is too.
const probe = (files) => (p) => files.some((f) => f.toLowerCase() === p.toLowerCase());
const winEnv = (extra = {}) => ({
  Path: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  ComSpec: "C:\\Windows\\System32\\cmd.exe",
  ...extra,
});

test("POSIX passes the command and arguments through untouched, without probing the disk", () => {
  for (const platform of ["darwin", "linux"]) {
    const args = ["-y", "a&b|c", "$(x)"];
    const out = resolveSpawnCommand("npx", args, {
      platform,
      env: { PATH: "/usr/bin" },
      isFile: () => { throw new Error("POSIX must not probe"); },
    });
    assert.deepEqual(out, { command: "npx", args, options: {} });
    assert.equal(out.args, args, "the same array, so spawn sees exactly what it saw before");
  }
});

test("Windows leaves an .exe to Node's own lookup", () => {
  const out = resolveSpawnCommand("node", ["server.js"], {
    platform: "win32",
    env: winEnv(),
    isFile: probe(["C:\\Program Files\\nodejs\\node.exe"]),
  });
  assert.deepEqual(out, { command: "node", args: ["server.js"], options: {} });
});

test("Windows leaves a command it cannot find to Node, which reports ENOENT as before", () => {
  const out = resolveSpawnCommand("missing", [], { platform: "win32", env: winEnv(), isFile: () => false });
  assert.deepEqual(out, { command: "missing", args: [], options: {} });
});

test("Windows launches a .cmd shim found on PATH through cmd.exe", () => {
  const out = resolveSpawnCommand("npx", ["-y", "server"], {
    platform: "win32",
    env: winEnv(),
    isFile: probe(["C:\\Program Files\\nodejs\\npx.cmd"]),
  });
  assert.equal(out.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(out.args.slice(0, 4), ["/d", "/v:off", "/s", "/c"]);
  assert.equal(out.args.length, 5);
  assert.deepEqual(out.options, { windowsVerbatimArguments: true });
  assert.ok(out.args[4].startsWith('"C:\\Program^ Files\\nodejs\\npx.cmd '), out.args[4]);
  assert.deepEqual(decode(out.args[4], "C:\\Program^ Files\\nodejs\\npx.cmd"), ["-y", "server"]);
});

test("Windows reads PATH, PATHEXT, and ComSpec case-insensitively and defaults what is missing", () => {
  const out = resolveSpawnCommand("pnpm", [], {
    platform: "win32",
    env: { PATH: "C:\\tools" },
    isFile: probe(["C:\\tools\\pnpm.cmd"]),
  });
  assert.equal(out.command, "cmd.exe");
  assert.match(out.args[4], /^"C:\\tools\\pnpm\.cmd"$/);
});

test("Windows follows PATH order, then PATHEXT order, the way cmd.exe does", () => {
  const env = winEnv({ Path: "C:\\first;C:\\second" });
  const exeFirst = resolveSpawnCommand("tool", [], { platform: "win32", env, isFile: probe(["C:\\first\\tool.exe", "C:\\second\\tool.cmd"]) });
  assert.equal(exeFirst.command, "tool");
  const cmdFirst = resolveSpawnCommand("tool", [], { platform: "win32", env, isFile: probe(["C:\\first\\tool.cmd", "C:\\second\\tool.exe"]) });
  assert.equal(cmdFirst.command, "C:\\Windows\\System32\\cmd.exe");
  const sameDir = resolveSpawnCommand("tool", [], { platform: "win32", env, isFile: probe(["C:\\first\\tool.cmd", "C:\\first\\tool.exe"]) });
  assert.equal(sameDir.command, "tool", ".EXE precedes .CMD in PATHEXT");
});

test("Windows skips quoted and empty PATH entries correctly", () => {
  const out = resolveSpawnCommand("yarn", [], {
    platform: "win32",
    env: winEnv({ Path: ';"C:\\Program Files\\Yarn\\bin";' }),
    isFile: probe(["C:\\Program Files\\Yarn\\bin\\yarn.cmd"]),
  });
  assert.equal(out.command, "C:\\Windows\\System32\\cmd.exe");
});

test("Windows launches an explicit .bat path without searching PATH", () => {
  const out = resolveSpawnCommand("C:\\servers\\run.bat", ["x"], {
    platform: "win32",
    env: winEnv(),
    isFile: probe(["C:\\servers\\run.bat"]),
  });
  assert.equal(out.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(decode(out.args[4], "C:\\servers\\run.bat"), ["x"]);
});

test("Windows escapes metacharacters in the shim's own path", () => {
  const shim = "C:\\Program Files (x86)\\a&b\\npx.cmd";
  const out = resolveSpawnCommand(shim, [], { platform: "win32", env: winEnv(), isFile: probe([shim]) });
  assert.equal(out.args[4], '"C:\\Program^ Files^ ^(x86^)\\a^&b\\npx.cmd"');
});

const HOSTILE = [
  "plain",
  "",
  "two words",
  "a&calc",
  "a|calc",
  "a^b",
  "%PATH%",
  "%%",
  "100%",
  "!PATH!",
  'say "hi"',
  '"&calc&"',
  '\\"&calc&\\"',
  "trailing\\",
  "trailing\\\\",
  'mid\\\\"quote',
  "C:\\dir with space\\",
  "(x) <in >out",
  "a;b,c=d",
  "`tick` *glob? [x]",
  "ünïcödé",
];

test("Windows round-trips hostile arguments through both cmd.exe parses without an operator escaping", () => {
  const out = resolveSpawnCommand("npx", HOSTILE, {
    platform: "win32",
    env: winEnv(),
    isFile: probe(["C:\\Program Files\\nodejs\\npx.cmd"]),
  });
  assert.deepEqual(decode(out.args[4], "C:\\Program^ Files\\nodejs\\npx.cmd"), HOSTILE);
});

test("Windows refuses a line break in an argument, since cmd.exe ends the command there", () => {
  for (const bad of ["a\nb", "a\rb"]) {
    assert.throws(
      () => resolveSpawnCommand("npx", [bad], { platform: "win32", env: winEnv(), isFile: probe(["C:\\Program Files\\nodejs\\npx.cmd"]) }),
      /line break/,
    );
  }
});

test("Windows refuses a NUL in an argument before it reaches cmd.exe", () => {
  assert.throws(
    () => resolveSpawnCommand("npx", ["a\0b"], { platform: "win32", env: winEnv(), isFile: probe(["C:\\Program Files\\nodejs\\npx.cmd"]) }),
    /NUL/,
  );
});

// The real thing, on the Windows CI job: a shim in a folder with spaces and
// parentheses, forwarding %* the way the npm, pnpm, and yarn shims do.
test("Windows: a real .cmd shim receives hostile arguments intact and runs nothing else", { skip: process.platform !== "win32" && "needs cmd.exe" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc spawn (x86) "));
  try {
    const marker = path.join(dir, "INJECTED");
    fs.writeFileSync(path.join(dir, "echo.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    fs.writeFileSync(path.join(dir, "echo-args.cmd"), `@"${process.execPath}" "%~dp0echo.js" %*\r\n`);
    const args = [...HOSTILE, `&echo x>"${marker}"`, `"&echo x>"${marker}"&"`, `^&echo x>"${marker}"`];
    const out = resolveSpawnCommand("echo-args", args, { env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` } });
    assert.ok(out.options.windowsVerbatimArguments, "expected the cmd.exe path");
    const stdout = execFileSync(out.command, out.args, { ...out.options, encoding: "utf8" });
    assert.deepEqual(JSON.parse(stdout), args);
    assert.equal(fs.existsSync(marker), false, "an argument ran a second command");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── A model of what Windows does to the command line ─────────────────────────
//
// cmd.exe parses the line once for `/c`, and parses the argument text again
// when the batch file expands %*. Each parse honors ^ outside quotes and
// treats & | < > outside quotes as operators. Node then splits its own command
// line with the MSVCRT rules. If any parse meets a live operator, or a % that
// could start a variable, the quoting is broken.

function decode(cLine, escapedCommand) {
  assert.ok(cLine.startsWith('"') && cLine.endsWith('"'), "/s strips one quote at each end");
  const line = cLine.slice(1, -1);
  const prefix = escapedCommand;
  assert.ok(line.startsWith(prefix), `expected ${line} to start with ${prefix}`);
  const argText = line.slice(prefix.length);
  if (argText === "") return [];
  assert.ok(argText.startsWith(" "));
  assertPercentsEscaped(argText);
  const afterOuter = cmdParse(argText);
  const afterBatch = cmdParse(afterOuter);
  return msvcrtSplit(afterBatch);
}

function assertPercentsEscaped(text) {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "%") assert.equal(text[i - 1], "^", `unescaped % at ${i} in ${text}`);
  }
}

function cmdParse(text) {
  let out = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      out += ch;
      if (ch === '"') quoted = false;
      continue;
    }
    if (ch === "^") { out += text[i + 1] ?? ""; i += 1; continue; }
    if (ch === '"') { quoted = true; out += ch; continue; }
    if ("&|<>".includes(ch)) assert.fail(`live cmd.exe operator ${ch} at ${i} in ${text}`);
    out += ch;
  }
  return out;
}

function msvcrtSplit(text) {
  const args = [];
  let cur = "";
  let inArg = false;
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      let n = 0;
      while (text[i] === "\\") { n += 1; i += 1; }
      if (text[i] === '"') {
        cur += "\\".repeat(Math.floor(n / 2));
        if (n % 2) cur += '"';
        else { quoted = !quoted; }
      } else {
        cur += "\\".repeat(n);
        i -= 1;
      }
      inArg = true;
      continue;
    }
    if (ch === '"') { quoted = !quoted; inArg = true; continue; }
    if (!quoted && (ch === " " || ch === "\t")) {
      if (inArg) { args.push(cur); cur = ""; inArg = false; }
      continue;
    }
    cur += ch;
    inArg = true;
  }
  if (inArg) args.push(cur);
  return args;
}
