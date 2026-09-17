// Spawned commands: the engine entrypoints that predate the command table
// (mcp, resolve, ingest, write, promote, pack, doctor). They keep their own
// flags and raw output; the dispatcher only injects the default manifest,
// guards `mcp`, and forwards the exit status.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ControlError } from "../control/errors.mjs";

export const ENGINE_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HELP_WORDS = new Set(["help", "--help", "-h"]);

// Every flag mcp-server.mjs documents. Anything else is refused before the
// server starts: --json or --quiet would corrupt the stdio channel's meaning,
// and --timeout would half-kill a session a harness expects to stay up
// (control-plane spec §5.1).
const MCP_VALUE_FLAGS = new Set(["--manifest", "--profile", "--personal", "--shared", "--harness"]);
const MCP_BOOLEAN_FLAGS = new Set(["--capture", "--telemetry", "--help", "-h"]);

export function guardMcpArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (MCP_VALUE_FLAGS.has(arg)) {
      if (args[index + 1] === undefined || args[index + 1].startsWith("-")) {
        throw new ControlError("INVALID_INPUT", `mcp: ${arg} requires a value.`, { status: 400 });
      }
      index += 1;
      continue;
    }
    if (MCP_BOOLEAN_FLAGS.has(arg)) continue;
    const reason = arg.startsWith("-")
      ? `mcp does not accept ${arg.split("=")[0]}: it serves a long-lived stdio session, and only its serving flags are allowed.`
      : `mcp does not take arguments: ${JSON.stringify(arg)}.`;
    throw new ControlError("INVALID_INPUT", reason, {
      status: 400,
      detail: { allowed: [...MCP_VALUE_FLAGS, ...MCP_BOOLEAN_FLAGS].filter((flag) => flag !== "-h") },
    });
  }
}

function missingManifest(manifestPath) {
  return new ControlError("MANIFEST_NOT_FOUND", `No manifest at ${manifestPath}. Run 'contextcake init' to create one, or pass --manifest.`, {
    status: 404,
    detail: { manifestPath },
  });
}

// Returns the argv the entrypoint receives. Mirrors the rules both CLI copies
// had before the dispatcher moved into the engine.
export function prepareSpawnArgs(command, argv, { manifestPath }) {
  const spec = command.spawn;
  const args = [...argv];
  if (command.id === "mcp") guardMcpArgs(args);
  const isHelp = args.some((arg) => HELP_WORDS.has(arg));
  if (spec.manifest === "inject") {
    const explicit = args.includes("--manifest") || args.includes("--personal") || args.includes("--legacy-paths");
    if (!isHelp && !explicit) {
      if (spec.requireManifest !== false && !fs.existsSync(manifestPath)) throw missingManifest(manifestPath);
      args.unshift("--manifest", manifestPath);
    }
  } else if (spec.manifest === "inject-after-subcommand") {
    if (!["inspect", ...HELP_WORDS].includes(args[0]) && !args.includes("--manifest")) {
      if (!fs.existsSync(manifestPath)) throw missingManifest(manifestPath);
      args.splice(1, 0, "--manifest", manifestPath);
    }
  }
  return args;
}

export function spawnEngine({ command, args, env, cwd, execPath, wrapSpawn, paths }) {
  const entry = path.join(ENGINE_SRC, command.spawn.entry);
  const wrapped = wrapSpawn
    ? wrapSpawn({ command: command.id, entry, args, env, paths })
    : { args: [entry, ...args], env };

  // This forks a SECOND, independent engine over the same manifest a running
  // desktop app's engine may already be serving: deliberate (the CLI must work
  // with the app closed) but not free, and `contextcake mcp` is the long-lived
  // case that normally runs while the app is open. What actually contends:
  //
  //   - Reads. MCP owns a retained, profile-bound index. Warm searches recheck
  //     listings and fingerprints without rereading unchanged documents. Cold
  //     scans and the desktop's background index remain independent.
  //   - Foreign MCP layers. Each engine spawns its own child per "source":"mcp"
  //     layer, so one manifest entry becomes two running server processes.
  //   - Disk cache. Layers with a `cache` block share one directory. Writes are
  //     pid-scoped tmp + rename so neither corrupts the other, but each process
  //     keeps its own memory cache and its own TTL clock.
  //   - Live git layers. git-core.mjs's advisory .contextcake.lock serializes
  //     mutations; the loser SKIPS its pull rather than blocking, so which
  //     engine sees fresh commits depends on who got the lock.
  //
  // Future: when the app is running, dispatch to its already-warm loopback
  // service instead of forking. The blocker is the bearer: it is minted per
  // launch and travels up the engine message port precisely so it never lands
  // in argv, env, or a file the CLI could read, so that handoff needs designing.
  const child = spawn(execPath, wrapped.args, { stdio: "inherit", env: wrapped.env, cwd });
  return new Promise((resolve) => {
    child.on("error", (error) => {
      resolve({ exitCode: 1, signal: null, error });
    });
    child.on("exit", (code, signal) => {
      resolve({ exitCode: code ?? 1, signal: signal ?? null });
    });
  });
}
