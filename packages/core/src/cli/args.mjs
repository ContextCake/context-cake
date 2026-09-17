// Strict argv parsing for table commands. Every flag a command accepts is
// declared in the table, so an unknown flag or a missing value is an input
// error (exit 2) rather than something silently ignored. Spawned commands are
// not parsed here: their entrypoints own their flags.

import { ControlError } from "../control/errors.mjs";
import { acceptedGlobalFlags } from "./table.mjs";

export function camelCase(name) {
  return name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function invalid(message) {
  return new ControlError("INVALID_INPUT", message, { status: 400 });
}

export function parseCommandArgs(command, argv) {
  const accepted = { ...acceptedGlobalFlags(command), ...command.flags };
  const flags = {};
  const positionals = [];
  let flagsDone = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (flagsDone || arg === "-" || !arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      flagsDone = true;
      continue;
    }
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw invalid(`Unknown option ${arg} for ${command.id}.`);
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const flag = accepted[name];
    if (!flag) throw invalid(`Unknown option --${name} for ${command.id}.`);
    const key = camelCase(name);
    let value;
    if (flag.type === "boolean") {
      if (eq !== -1) throw invalid(`--${name} does not take a value.`);
      value = true;
    } else {
      if (eq !== -1) value = arg.slice(eq + 1);
      else {
        value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) throw invalid(`--${name} requires a value.`);
        index += 1;
      }
      if (value === "") throw invalid(`--${name} requires a value.`);
      if (flag.type === "integer") {
        if (!/^-?\d+$/.test(value)) throw invalid(`--${name} must be an integer.`);
        value = Number(value);
      }
    }
    if (flag.repeatable) (flags[key] ??= []).push(value);
    else if (Object.hasOwn(flags, key) && flag.type !== "boolean") throw invalid(`--${name} was given more than once.`);
    else flags[key] = value;
  }
  if (flags.help) return { flags, positionals, args: {} };

  for (const [name, flag] of Object.entries(command.flags)) {
    if (flag.required && !Object.hasOwn(flags, camelCase(name))) throw invalid(`--${name} is required for ${command.id}.`);
  }
  const args = {};
  let cursor = 0;
  for (const positional of command.positionals) {
    if (positional.variadic) {
      args[camelCase(positional.name)] = positionals.slice(cursor);
      cursor = positionals.length;
      if (positional.required && args[camelCase(positional.name)].length === 0) throw invalid(`<${positional.name}> is required for ${command.id}.`);
      continue;
    }
    if (cursor >= positionals.length) {
      if (positional.required) throw invalid(`<${positional.name}> is required for ${command.id}.`);
      continue;
    }
    args[camelCase(positional.name)] = positionals[cursor];
    cursor += 1;
  }
  if (cursor < positionals.length) throw invalid(`Unexpected argument ${JSON.stringify(positionals[cursor])} for ${command.id}.`);
  return { flags, positionals, args };
}

// 1500, 1500ms, 30s, 2m. Bounded so a typo cannot park a command for a day.
export function parseTimeout(value) {
  const match = /^(\d+)(ms|s|m)?$/.exec(String(value));
  if (!match) throw invalid("--timeout must be a duration such as 1500, 30s, or 2m.");
  const ms = Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000 }[match[2] ?? "ms"]);
  if (ms < 1 || ms > 3_600_000) throw invalid("--timeout must be between 1ms and 60m.");
  return ms;
}
