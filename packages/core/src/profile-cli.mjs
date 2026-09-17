#!/usr/bin/env node

// Read-only profile inspection and locked local profile configuration.
// No command in this file opens a source adapter.
//
// This is the raw `node profile.mjs` surface: its flags, text, and bare JSON
// stay as they were. The operations live in control/profiles.mjs, which the
// `contextcake profile` family also uses (with the JSON envelope instead).

import {
  PROFILE_TEXT,
  createProfile,
  currentProfile,
  deleteProfile,
  listProfiles,
  mapProject,
  unmapProject,
} from "./control/profiles.mjs";

main();

function main() {
  const { command, positionals, options } = parseArgs(process.argv.slice(2));
  if (options.help || !command || command === "help") {
    printHelp();
    process.exit(command || options.help ? 0 : 1);
  }
  if (!options.manifest) throw new Error("--manifest <file> is required.");
  const manifestPath = options.manifest;

  if (command === "current") {
    const result = currentProfile({ manifestPath, profile: options.profile ?? null, cwd: process.cwd() });
    return output(result, options, PROFILE_TEXT.current(result));
  }
  if (command === "list") {
    const profiles = listProfiles({ manifestPath });
    return output(profiles, options, PROFILE_TEXT.list(profiles));
  }
  if (command === "create") {
    const response = createProfile({ manifestPath, label: positionals.join(" "), project: options.project ?? null });
    return output(response, options, PROFILE_TEXT.create(response));
  }
  if (command === "map") {
    if (positionals.length !== 2) throw new Error("Usage: profile map <id> <path> --manifest <file>");
    const result = mapProject({ manifestPath, profileId: positionals[0], projectPath: positionals[1] });
    return output(result, options, PROFILE_TEXT.map(result));
  }
  if (command === "unmap") {
    if (positionals.length !== 1) throw new Error("Usage: profile unmap <path> --manifest <file>");
    const result = unmapProject({ manifestPath, projectPath: positionals[0] });
    return output(result, options, PROFILE_TEXT.unmap(result));
  }
  if (command === "delete") {
    if (positionals.length !== 1) throw new Error("Usage: profile delete <id> --manifest <file> [--confirm]");
    const result = deleteProfile({ manifestPath, profileId: positionals[0], confirm: options.confirm === true });
    if (!result.deleted) {
      output(result, options, PROFILE_TEXT.deletePreview(result));
      process.exitCode = 2;
      return;
    }
    return output(result, options, PROFILE_TEXT.deleted(result));
  }
  throw new Error(`Unknown profile command: ${command}`);
}

function output(value, options, text) {
  console.log(options.json ? JSON.stringify(value, null, 2) : text);
}

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  let command = null;
  const booleanFlags = new Set(["json", "confirm", "help"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h") options.help = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (booleanFlags.has(key)) options[key] = true;
      else {
        if (argv[index + 1] === undefined || argv[index + 1].startsWith("--")) throw new Error(`${arg} requires a value.`);
        options[key] = argv[index + 1];
        index += 1;
      }
    } else if (command === null) command = arg;
    else positionals.push(arg);
  }
  return { command, positionals, options };
}

function printHelp() {
  console.log(`Usage: contextcake profile <command> [options]

  current [--profile <id>] [--json]  Show the selected profile and reason
  list [--json]                      List profiles without opening sources
  create <label> [--project <path>] Create an empty profile; safely migrate legacy manifests
  map <id> <path>                    Map a local project folder to a profile
  unmap <path>                       Remove one project mapping
  delete <id> [--confirm]            Remove references only; retire profile state; never source files

All commands require --manifest <file>. Automatic selection uses the current
working directory; --profile wins when provided to current.
`);
}
