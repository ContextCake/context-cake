#!/usr/bin/env node
// `contextcake`: the one dispatcher both shipped CLIs wrap (control-plane
// design §2). The Mac app's src/cli/cli.mjs and the npm package's bin locate
// this file and call main(); the app passes a wrapSpawn hook so `mcp` and
// `doctor` run through its observability launchers.
//
// Routing and `help --json` both come from the command table in
// ./cli/families/. Table commands answer with the JSON envelope under --json;
// spawned commands keep the flags and raw output they always had.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ControlError, EXIT_CATEGORIES, exitCategoryFor, exitCodeFor, toControlError } from "./control/errors.mjs";
import { createRedactor } from "./control/redact.mjs";
import { resolvePaths } from "./platform-paths.mjs";
import { parseCommandArgs, parseTimeout } from "./cli/args.mjs";
import { ABORT, CLOSE, createCommandContext } from "./cli/context.mjs";
import { FAMILIES } from "./cli/families/index.mjs";
import { prepareSpawnArgs, spawnEngine } from "./cli/spawn.mjs";
import { buildTable, describeCommand, helpSchema, resolveCommand, usageLine } from "./cli/table.mjs";

export const ENVELOPE_SCHEMA_VERSION = 1;

// sources/mcp.mjs gives a child 300ms after SIGTERM, then SIGKILL and up to
// 700ms more; the process must not exit inside that window.
const ABANDONED_EXIT_DELAY_MS = 1000;

export const TABLE = buildTable(FAMILIES);

const HELP_WORDS = new Set(["help", "--help", "-h"]);

function write(stream, text) {
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
}

function emptyContext(manifestPath = null) {
  return { manifestPath, manifestRevision: null, profileId: null, profileReason: null };
}

export function buildEnvelope({ command, ok, context, data = null, coverage, error = null, warnings = [], nextActions = [] }) {
  const envelope = {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    ok,
    command,
    context,
    data: ok ? data : null,
  };
  if (coverage !== undefined) envelope.coverage = coverage;
  if (!ok) {
    const failure = toControlError(error);
    const category = exitCategoryFor(failure);
    envelope.error = {
      code: failure.code,
      message: failure.message,
      details: failure.detail ?? null,
      retryable: failure.retryable === true,
      category,
      exitCode: EXIT_CATEGORIES[category],
    };
  }
  envelope.warnings = warnings;
  envelope.nextActions = nextActions;
  return envelope;
}

function usageText(table, paths) {
  const rows = table.families.map((family) => {
    const tag = family.stability === "stable" ? "" : "  (experimental)";
    return `  ${family.name.padEnd(9)} ${family.summary}${tag}`;
  });
  return [
    "contextcake <command> [options]",
    "",
    ...rows,
    "",
    "Commands taking --manifest default to:",
    `  ${paths.manifest}`,
    "",
    "Run 'contextcake help <command>' for details, or 'contextcake help --json' for the contract.",
    "",
    "Connect a harness:  claude mcp add contextcake -- contextcake mcp",
  ].join("\n");
}

function familyHelpText(family) {
  const lines = [`contextcake ${family.name}: ${family.summary}${family.stability === "stable" ? "" : " (experimental)"}`, ""];
  for (const command of family.commands) lines.push(`  ${usageLine(command)}`, `      ${command.summary}`);
  return lines.join("\n");
}

function commandHelpText(command) {
  const description = describeCommand(command);
  if (command.spawn) {
    return [`Usage: ${description.usage}`, "", command.summary, "", `Run 'contextcake ${command.id} --help' for its options.`].join("\n");
  }
  const lines = [`Usage: ${description.usage}`, "", command.summary];
  if (command.positionals.length) {
    lines.push("", "Arguments:");
    for (const positional of command.positionals) lines.push(`  <${positional.name}>  ${positional.description}`);
  }
  lines.push("", "Options:");
  for (const flag of description.inputs.flags) {
    const name = flag.type === "boolean" ? flag.name : `${flag.name} <${flag.type === "integer" ? "n" : "value"}>`;
    lines.push(`  ${name.padEnd(28)} ${flag.description}`);
  }
  lines.push("", `Mutation: ${command.mutation}. Stability: ${command.stability}.`);
  return lines.join("\n");
}

function jsonRequested(argv) {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).includes("--json");
}

/**
 * Runs one CLI invocation without touching process state, so tests can call
 * it in-process. Returns { exitCode, signal }.
 *
 * options: env, cwd, stdout, stderr, version, execPath, stdinIsTTY,
 *   table (tests pass a table built from their own families),
 *   secrets (values to scrub, e.g. an injected token map),
 *   wrapSpawn({ command, entry, args, env, paths }) -> { args, env },
 *   interrupt (a promise that resolves when the user interrupts).
 */
export async function runCli(argv, options = {}) {
  // Cleanups registered with ctx.onClose run once the answer is written and
  // before runCli returns, whether run() finished, failed, or was abandoned.
  const scope = { ctx: null };
  try {
    return await dispatch(argv, options, scope);
  } finally {
    await scope.ctx?.[CLOSE]();
  }
}

async function dispatch(argv, options, scope) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const version = options.version ?? "unknown";
  const paths = resolvePaths({ env });
  const baseRedactor = createRedactor(options.secrets ?? []);
  const json = jsonRequested(argv);
  const table = options.table ?? TABLE;

  const fail = (commandId, error, context = emptyContext(), warnings = [], nextActions = [], redactor = baseRedactor) => {
    const failure = toControlError(error);
    if (json) {
      const envelope = buildEnvelope({ command: commandId, ok: false, context, error: failure, warnings, nextActions });
      write(stdout, JSON.stringify(redactor.redact(envelope)));
    } else if (failure.text) {
      write(stdout, redactor.redactString(failure.text));
    } else {
      write(stderr, `contextcake: ${redactor.redactString(failure.message)}`);
    }
    return { exitCode: exitCodeFor(failure), signal: null };
  };

  const [first, second] = argv;
  if (first === undefined) {
    write(stdout, usageText(table, paths));
    return { exitCode: 1, signal: null };
  }
  if (first === "--version" || first === "-v") {
    write(stdout, version);
    return { exitCode: 0, signal: null };
  }

  if (HELP_WORDS.has(first)) {
    const topic = argv.slice(1).filter((arg) => !arg.startsWith("-"));
    if (json) {
      const data = helpSchema(table, { version });
      if (topic.length) {
        if (!table.families.some((candidate) => candidate.name === topic[0])) {
          return fail("help", new ControlError("UNKNOWN_COMMAND", `Unknown command '${topic[0]}'.`, { status: 400 }));
        }
        data.families = data.families.filter((candidate) => candidate.name === topic[0]);
        data.commands = data.commands.filter((candidate) => candidate.family === topic[0]);
      }
      const envelope = buildEnvelope({ command: "help", ok: true, context: emptyContext(), data });
      write(stdout, JSON.stringify(envelope));
      return { exitCode: 0, signal: null };
    }
    if (!topic.length) {
      write(stdout, usageText(table, paths));
      return { exitCode: 0, signal: null };
    }
    const found = resolveCommand(table, topic);
    if (!found.family) return fail("help", new ControlError("UNKNOWN_COMMAND", `unknown command '${topic[0]}'`, { status: 400 }));
    write(stdout, found.command && (found.command.name === null || topic.length > 1) ? commandHelpText(found.command) : familyHelpText(found.family));
    return { exitCode: 0, signal: null };
  }

  const { family, command, rest } = resolveCommand(table, argv);
  if (!family) {
    if (!json) write(stderr, `contextcake: unknown command '${first}'\n\n${usageText(table, paths)}`);
    return json ? fail(null, new ControlError("UNKNOWN_COMMAND", `Unknown command '${first}'.`, { status: 400 })) : { exitCode: 2, signal: null };
  }
  if (!command) {
    if (second === undefined || HELP_WORDS.has(second)) {
      write(stdout, familyHelpText(family));
      return { exitCode: second === undefined ? 1 : 0, signal: null };
    }
    return fail(null, new ControlError("UNKNOWN_COMMAND", `Unknown ${family.name} command '${second}'. Run 'contextcake help ${family.name}'.`, { status: 400 }));
  }

  if (command.spawn) {
    let args;
    try {
      args = prepareSpawnArgs(command, rest, { manifestPath: path.resolve(cwd, paths.manifest) });
    } catch (error) {
      // Never write to stdout for mcp: it is the protocol channel.
      if (command.id === "mcp") {
        write(stderr, `contextcake: ${baseRedactor.redactString(toControlError(error).message)}`);
        return { exitCode: exitCodeFor(toControlError(error)), signal: null };
      }
      return fail(command.id, error, emptyContext(path.resolve(cwd, paths.manifest)));
    }
    const result = await spawnEngine({
      command,
      args,
      env,
      cwd,
      execPath: options.execPath ?? process.execPath,
      wrapSpawn: options.wrapSpawn ?? null,
      paths,
    });
    if (result.error) write(stderr, `contextcake: could not start ${command.id}: ${baseRedactor.redactString(result.error.message)}`);
    return { exitCode: result.exitCode, signal: result.signal };
  }

  let parsed;
  try {
    parsed = parseCommandArgs(command, rest);
  } catch (error) {
    return fail(command.id, error);
  }
  if (parsed.flags.help) {
    write(stdout, commandHelpText(command));
    return { exitCode: 0, signal: null };
  }

  const ctx = createCommandContext({
    command,
    table,
    parsed,
    env,
    cwd,
    stderr,
    secrets: options.secrets ?? [],
    hooks: { stdinIsTTY: options.stdinIsTTY ?? false, wrapSpawn: options.wrapSpawn ?? null, version },
  });
  const failWithContext = (error) => {
    ctx.collectManifestSecrets();
    return fail(command.id, error, ctx.context, ctx.warnings, ctx.nextActions, { redact: ctx.redact, redactString: (text) => ctx.redact(text) });
  };

  scope.ctx = ctx;

  // --timeout and interrupts abort ctx.signal with the error the command
  // answers with. A read is abandoned at once: its envelope goes out and
  // main() ends the process even if the read ignores the signal. A write is
  // never abandoned: it runs to the end (so an answer can never say
  // INTERRUPTED over a mutation that then lands), and it reports the abort
  // only if it stopped for it, by calling ctx.throwIfAborted() before its
  // point of no return.
  let timer = null;
  let result;
  let abandoned = false;
  try {
    // Validated before run() starts: a refused --timeout must not leave a
    // mutation running behind the error.
    const ms = parsed.flags.timeout === undefined ? null : parseTimeout(parsed.flags.timeout);
    if (ms !== null && !command.acceptsTimeout) {
      throw new ControlError("TIMEOUT_REFUSED", `${command.id} changes state, so it does not accept --timeout.`, { status: 400 });
    }
    const isRead = command.mutation === "read";
    const running = Promise.resolve().then(() => (isRead ? command.run(ctx) : ctx.critical(() => command.run(ctx))));
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
    aborted.catch(() => {});
    const abort = (error) => {
      ctx[ABORT](error);
      rejectAbort(error);
    };
    if (ms !== null) {
      // Referenced on purpose: the timer is what keeps a stalled command's
      // process alive long enough to report the timeout.
      timer = setTimeout(() => abort(new ControlError("TIMEOUT", `${command.id} did not finish within ${ms}ms.`, { status: 504, retryable: true })), ms);
    }
    options.interrupt?.then(async () => {
      // A read holds the interrupt while a critical section runs.
      while (isRead && ctx.inCriticalSection) await new Promise((resolve) => setTimeout(resolve, 10));
      abort(new ControlError("INTERRUPTED", `${command.id} was interrupted.`));
    });
    if (isRead) {
      try {
        result = await Promise.race([running, aborted]);
      } catch (error) {
        if (ctx.signal.aborted && error === ctx.signal.reason) abandoned = true;
        throw error;
      }
    } else {
      result = await running;
    }
  } catch (error) {
    return { ...failWithContext(error), abandoned };
  } finally {
    clearTimeout(timer);
  }

  if (!result || !Object.hasOwn(result, "data")) {
    return failWithContext(new ControlError("INTERNAL", `${command.id} returned no data.`));
  }
  if (command.coverage && !result.coverage) {
    return failWithContext(new ControlError("INTERNAL", `${command.id} must report coverage.`));
  }
  if (command.coverage && result.coverage.complete === false && (parsed.flags.requireComplete || command.requireComplete)) {
    return failWithContext(new ControlError("INCOMPLETE_COVERAGE", "Some sources could not be read.", { status: 503, detail: result.coverage, retryable: true }));
  }
  for (const warning of result.warnings ?? []) ctx.warnings.push(warning);
  ctx.collectManifestSecrets();

  if (json) {
    const envelope = buildEnvelope({
      command: command.id,
      ok: true,
      context: ctx.context,
      data: result.data,
      coverage: command.coverage ? result.coverage : undefined,
      warnings: ctx.warnings,
      nextActions: ctx.nextActions,
    });
    write(stdout, JSON.stringify(ctx.redact(envelope)));
  } else {
    const text = result.text ?? JSON.stringify(result.data, null, 2);
    if (text) write(stdout, ctx.redact(text));
    if (!ctx.quiet) for (const warning of ctx.warnings) write(stderr, `warning: ${ctx.redact(warning.message)}`);
  }
  return { exitCode: 0, signal: null };
}

// Process entry: wires signals and exit status. Uses process.exitCode, not
// process.exit(), so a large envelope on a pipe is never cut off.
export async function main(argv = process.argv.slice(2), options = {}) {
  let onInterrupt;
  const interrupt = new Promise((resolve) => { onInterrupt = resolve; });
  const resolved = resolveCommand(options.table ?? TABLE, argv);
  const handlesSignals = Boolean(resolved.command?.run);
  // The first interrupt goes to the command (a write finishes first). A
  // second one is the user insisting: stop now.
  let interrupts = 0;
  const listener = () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(EXIT_CATEGORIES.interrupted);
    onInterrupt();
  };
  if (handlesSignals) process.on("SIGINT", listener);
  // A handler awaiting something that holds no handle (a promise nobody will
  // settle) would otherwise let the process exit 0 with no answer at all.
  let answered = false;
  const stalled = () => {
    if (answered) return;
    answered = true;
    process.stderr.write("contextcake: the command stopped without an answer. This is a bug.\n");
    process.exitCode = EXIT_CATEGORIES.internal;
  };
  process.once("beforeExit", stalled);
  try {
    const { exitCode, signal, abandoned } = await runCli(argv, { stdinIsTTY: Boolean(process.stdin.isTTY), ...options, interrupt });
    answered = true;
    process.off("beforeExit", stalled);
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = exitCode;
    // An abandoned read may still hold a socket or timer after its envelope
    // is out. Its ctx.onClose cleanups already ran inside runCli; give stdout
    // and any child a SIGTERM grace plus SIGKILL's worth of time, then end the
    // process. Unref'd, so a process with nothing left running exits sooner.
    if (abandoned) setTimeout(() => process.exit(exitCode), ABANDONED_EXIT_DELAY_MS).unref();
  } finally {
    if (handlesSignals) process.off("SIGINT", listener);
  }
}

function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) await main();
