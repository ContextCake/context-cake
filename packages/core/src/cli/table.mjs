// The command table: one structure that both routes argv and generates
// `help --json` (control-plane design §2), so the two cannot drift.
//
// A family is a module under ./families/ that default-exports defineFamily().
// Each command either runs in-process (`run(ctx)`, answered with the JSON
// envelope) or spawns an engine entrypoint (`spawn`, raw output). Traits the
// dispatcher enforces are declared here, not coded per command: which global
// flags a command accepts, which error codes it can answer with, whether it
// may report coverage, and whether --timeout is allowed.

import { CODE_CATEGORIES, EXIT_CATEGORIES } from "../control/errors.mjs";

export const STABILITY = new Set(["stable", "experimental"]);
// read: never writes. write: changes configuration or content. destructive:
// deletes data a user cannot get back. serve: long-lived process.
export const MUTATION = new Set(["read", "write", "destructive", "serve"]);
export const MANIFEST_USE = new Set(["required", "optional", "creates", "none"]);
export const FLAG_TYPES = new Set(["boolean", "string", "integer"]);

// Global flags, and the trait that makes a command accept each one.
export const GLOBAL_FLAGS = {
  json: { type: "boolean", description: "Write exactly one JSON envelope to stdout; logs go to stderr." },
  "no-input": { type: "boolean", description: "Never prompt. A step that needs a human fails instead." },
  quiet: { type: "boolean", description: "Suppress logs and warnings on stderr." },
  help: { type: "boolean", description: "Show help for this command." },
  timeout: { type: "string", description: "Give up after this long (ms, or with an s/m suffix). Read commands only unless a command says otherwise." },
  manifest: { type: "string", description: "Manifest file. Defaults to the platform config directory.", when: (c) => c.manifest !== "none" },
  profile: { type: "string", description: "Profile id. Wins over the project mapping for --cwd.", when: (c) => c.profile },
  cwd: { type: "string", description: "Select the profile mapped to this folder instead of the working directory.", when: (c) => c.profile },
  "expect-revision": { type: "string", description: "Refuse unless the manifest still has this revision (sha256:...).", when: (c) => c.preconditions.includes("manifest-revision") },
  "require-complete": { type: "boolean", description: "Exit 6 instead of 0 when a source could not be read.", when: (c) => c.coverage && !c.requireComplete },
};

// Every command can fail these ways; traits add the rest.
const BASE_ERRORS = ["INVALID_INPUT", "INTERNAL", "INTERRUPTED"];

export function defineFamily(family) {
  const errors = [];
  const where = `CLI family ${family?.name ?? "(unnamed)"}`;
  if (!family || typeof family.name !== "string" || !/^[a-z][a-z-]*$/.test(family.name)) errors.push("name must be lowercase words");
  if (!STABILITY.has(family?.stability)) errors.push("stability must be stable or experimental");
  if (typeof family?.summary !== "string" || !family.summary) errors.push("summary is required");
  if (!Array.isArray(family?.commands) || family.commands.length === 0) errors.push("commands must be a non-empty array");
  if (errors.length) throw new Error(`${where}: ${errors.join("; ")}`);
  const commands = family.commands.map((command) => normalizeCommand(family, command));
  const names = new Set();
  for (const command of commands) {
    if (names.has(command.id)) throw new Error(`${where}: duplicate command ${command.id}`);
    names.add(command.id);
  }
  if (commands.some((command) => command.name === null) && commands.length > 1) {
    throw new Error(`${where}: a family-root command cannot share its family with subcommands`);
  }
  return Object.freeze({ name: family.name, stability: family.stability, summary: family.summary, commands });
}

function normalizeCommand(family, command) {
  const name = command.name ?? null;
  const id = name ? `${family.name}.${name}` : family.name;
  const fail = (message) => { throw new Error(`CLI command ${id}: ${message}`); };
  if (name !== null && !/^[a-z][a-z-]*$/.test(name)) fail("name must be lowercase words");
  if (typeof command.summary !== "string" || !command.summary) fail("summary is required");
  if (!MUTATION.has(command.mutation)) fail(`mutation must be one of ${[...MUTATION].join(", ")}`);
  const manifest = command.manifest ?? "none";
  if (!MANIFEST_USE.has(manifest)) fail(`manifest must be one of ${[...MANIFEST_USE].join(", ")}`);
  if (Boolean(command.run) === Boolean(command.spawn)) fail("define exactly one of run or spawn");
  const coverage = command.coverage === true;
  if (coverage && command.mutation !== "read") fail("only read commands may report coverage (spec §5.2)");
  // An explicit check (`source test`, `source sync`) must fail on partial
  // coverage even without --require-complete (spec §5.2).
  const requireComplete = command.requireComplete === true;
  if (requireComplete && !coverage) fail("requireComplete needs coverage: true");
  const preconditions = [...(command.preconditions ?? [])];
  if (preconditions.includes("manifest-revision") && command.mutation === "read") fail("a read command has no revision to expect");

  const positionals = (command.positionals ?? []).map((positional, index, all) => {
    if (!/^[a-z][a-z-]*$/.test(positional.name ?? "")) fail("positional names must be lowercase words");
    if (positional.variadic && index !== all.length - 1) fail("only the last positional may be variadic");
    return { name: positional.name, required: positional.required === true, variadic: positional.variadic === true, description: positional.description ?? "" };
  });
  const flags = {};
  for (const [flagName, flag] of Object.entries(command.flags ?? {})) {
    if (Object.hasOwn(GLOBAL_FLAGS, flagName)) fail(`--${flagName} is a global flag; declare the trait instead`);
    if (!/^[a-z][a-z-]*$/.test(flagName)) fail(`flag ${flagName} must be lowercase words`);
    if (!FLAG_TYPES.has(flag.type)) fail(`flag --${flagName} needs a type of ${[...FLAG_TYPES].join(", ")}`);
    flags[flagName] = { type: flag.type, required: flag.required === true, repeatable: flag.repeatable === true, description: flag.description ?? "" };
  }
  const normalized = {
    id,
    family: family.name,
    name,
    stability: family.stability,
    summary: command.summary,
    mutation: command.mutation,
    manifest,
    profile: command.profile === true,
    coverage,
    requireComplete,
    acceptsTimeout: command.mutation === "read" || command.acceptsTimeout === true,
    preconditions,
    positionals,
    flags,
    output: command.spawn ? { passthrough: true } : (command.output ?? { type: "object" }),
    run: command.run ?? null,
    spawn: command.spawn ?? null,
  };
  normalized.errors = commandErrors(normalized, command.errors ?? []);
  for (const code of normalized.errors) {
    if (!Object.hasOwn(CODE_CATEGORIES, code) && !command.errorCategories?.[code]) {
      fail(`error code ${code} has no exit category in control/errors.mjs`);
    }
  }
  normalized.errorCategories = { ...(command.errorCategories ?? {}) };
  return Object.freeze(normalized);
}

function commandErrors(command, declared) {
  const codes = [...BASE_ERRORS];
  if (command.manifest === "required") codes.push("MANIFEST_NOT_FOUND", "MANIFEST_INVALID");
  if (command.manifest === "optional" || command.manifest === "creates") codes.push("MANIFEST_INVALID");
  if (command.mutation !== "read" && command.manifest !== "none") codes.push("MANIFEST_LOCKED");
  if (command.profile) codes.push("PROFILE_NOT_FOUND");
  if (command.preconditions.includes("manifest-revision")) codes.push("STALE_REVISION");
  if (command.preconditions.includes("confirm")) codes.push("CONFIRMATION_REQUIRED");
  if (command.acceptsTimeout) codes.push("TIMEOUT");
  else codes.push("TIMEOUT_REFUSED");
  if (command.coverage) codes.push("INCOMPLETE_COVERAGE");
  return [...new Set([...codes, ...declared])];
}

// Global flags a command accepts, in help order.
export function acceptedGlobalFlags(command) {
  if (command.spawn) return {};
  return Object.fromEntries(Object.entries(GLOBAL_FLAGS).filter(([, flag]) => !flag.when || flag.when(command)));
}

export function buildTable(families) {
  const byId = new Map();
  const familyNames = new Set();
  for (const family of families) {
    if (familyNames.has(family.name)) throw new Error(`CLI family registered twice: ${family.name}`);
    familyNames.add(family.name);
    for (const command of family.commands) byId.set(command.id, command);
  }
  return Object.freeze({ families: Object.freeze([...families]), byId });
}

// Longest match wins: `profile show` before a family-root `profile`.
export function resolveCommand(table, argv) {
  const [first, second] = argv;
  const family = table.families.find((candidate) => candidate.name === first);
  if (!family) return { family: null, command: null, rest: argv.slice(1) };
  const root = family.commands.find((command) => command.name === null);
  if (root) return { family, command: root, rest: argv.slice(1) };
  const command = family.commands.find((candidate) => candidate.name === second) ?? null;
  return { family, command, rest: command ? argv.slice(2) : argv.slice(1) };
}

export function usageLine(command) {
  const words = ["contextcake", ...(command.name ? [command.family, command.name] : [command.family])];
  for (const positional of command.positionals) {
    const token = `<${positional.name}>${positional.variadic ? "..." : ""}`;
    words.push(positional.required ? token : `[${token}]`);
  }
  for (const [name, flag] of Object.entries(command.flags)) {
    const token = flag.type === "boolean" ? `--${name}` : `--${name} <${flag.type === "integer" ? "n" : "value"}>`;
    words.push(flag.required ? token : `[${token}]`);
  }
  if (command.spawn) words.push("[options]");
  return words.join(" ");
}

function flagSchema(name, flag, global) {
  return { name: `--${name}`, type: flag.type, required: flag.required === true, repeatable: flag.repeatable === true, global, description: flag.description ?? "" };
}

function errorSchema(command, code) {
  const category = command.errorCategories[code] ?? CODE_CATEGORIES[code];
  return { code, category, exitCode: EXIT_CATEGORIES[category] };
}

export function describeCommand(command) {
  return {
    id: command.id,
    family: command.family,
    stability: command.stability,
    summary: command.summary,
    usage: usageLine(command),
    mutation: command.mutation,
    manifest: command.manifest,
    profileAware: command.profile,
    output: command.spawn ? "passthrough" : "envelope",
    inputs: {
      positionals: command.positionals,
      flags: [
        ...Object.entries(command.flags).map(([name, flag]) => flagSchema(name, flag, false)),
        ...Object.entries(acceptedGlobalFlags(command)).map(([name, flag]) => flagSchema(name, flag, true)),
      ],
    },
    preconditions: [
      ...(command.manifest === "required" ? ["manifest-exists"] : []),
      ...(command.profile ? ["profile-selected"] : []),
      ...command.preconditions,
    ],
    errors: command.spawn ? [] : command.errors.map((code) => errorSchema(command, code)),
    coverage: command.coverage,
    requireComplete: command.requireComplete,
    timeout: command.spawn ? "passthrough" : (command.acceptsTimeout ? "accepted" : "refused"),
    dataSchema: command.spawn ? null : command.output,
  };
}

export const EXIT_CODE_MEANINGS = {
  ok: "success",
  internal: "internal error",
  "invalid-input": "invalid input or usage",
  "not-found": "uninitialized or not found",
  conflict: "conflict, failed precondition, or confirmation required (the error code says which)",
  permission: "permission, trust, or credential",
  unavailable: "unavailable, network, timeout, or incomplete coverage when required",
  integrity: "integrity problem; recovery or repair required",
  unhealthy: "diagnostics found a problem",
  interrupted: "interrupted",
};

export function helpSchema(table, { version }) {
  return {
    cli: "contextcake",
    version,
    envelope: {
      schemaVersion: 1,
      fields: ["schemaVersion", "ok", "command", "context", "data", "coverage?", "error?", "warnings", "nextActions"],
      context: ["manifestPath", "manifestRevision", "profileId", "profileReason"],
      error: ["code", "message", "details", "retryable", "category", "exitCode"],
    },
    exitCodes: Object.entries(EXIT_CATEGORIES).map(([category, code]) => ({ code, category, meaning: EXIT_CODE_MEANINGS[category] })),
    globalFlags: Object.entries(GLOBAL_FLAGS).map(([name, flag]) => flagSchema(name, flag, true)),
    families: table.families.map((family) => ({
      name: family.name,
      stability: family.stability,
      summary: family.summary,
      commands: family.commands.map((command) => command.id),
    })),
    commands: table.families.flatMap((family) => family.commands.map(describeCommand)),
  };
}
