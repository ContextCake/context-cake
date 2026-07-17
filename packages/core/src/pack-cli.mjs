#!/usr/bin/env node

import {
  inspectPack,
  installPack,
  listPacks,
  previewPackUpdate,
  removePack,
  rollbackPack,
} from "./pack-manager.mjs";

const [command, ...argv] = process.argv.slice(2);

try {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    process.exit(command ? 0 : 1);
  }
  const args = parseArgs(argv);
  let result;
  if (command === "inspect") {
    result = inspectPack(requiredPositional(args, "Pack directory"), { expectedChecksum: args.checksum });
  } else if (command === "install") {
    result = installPack({
      sourceRoot: requiredPositional(args, "Pack directory"),
      manifestPath: requiredOption(args, "manifest"),
      packsDir: args["packs-dir"],
      profile: args.profile ?? null,
      level: args.level ?? 0,
      expectedChecksum: args.checksum,
    });
  } else if (command === "update") {
    const options = {
      sourceRoot: requiredPositional(args, "Pack directory"),
      manifestPath: requiredOption(args, "manifest"),
      packsDir: args["packs-dir"],
      profile: args.profile ?? null,
      expectedChecksum: args.checksum,
    };
    result = args.apply
      ? installPack({ ...options, level: args.level, allowUpdate: true })
      : previewPackUpdate(options);
  } else if (command === "list") {
    result = listPacks(requiredOption(args, "manifest"));
  } else if (command === "rollback") {
    result = rollbackPack({
      packId: requiredPositional(args, "Pack id"),
      manifestPath: requiredOption(args, "manifest"),
      packsDir: args["packs-dir"],
      profile: args.profile ?? null,
      version: args.version ?? null,
    });
  } else if (command === "remove") {
    result = removePack({
      packId: requiredPositional(args, "Pack id"),
      manifestPath: requiredOption(args, "manifest"),
      profile: args.profile ?? null,
    });
  } else {
    throw new Error(`Unknown Pack command: ${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function parseArgs(values) {
  const parsed = { positional: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      parsed.positional.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (key === "apply") {
      // Boolean flag: consume only an explicit true/false, otherwise stand alone
      // so a following positional (the Pack directory) is never swallowed.
      if (next === "true" || next === "false") { parsed[key] = next === "true"; index += 1; }
      else parsed[key] = true;
      continue;
    }
    if (!next || next.startsWith("--")) throw new Error(`Option --${key} requires a value.`);
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function requiredPositional(args, label) {
  if (!args.positional[0]) throw new Error(`${label} is required.`);
  return args.positional[0];
}

function requiredOption(args, key) {
  if (!args[key]) throw new Error(`--${key} is required.`);
  return args[key];
}

function printHelp() {
  console.log(`Usage:
  contextcake pack inspect <directory> [--checksum sha256:...]
  contextcake pack install <directory> --manifest <file> [--profile <id>] [--level <n>]
  contextcake pack update <directory> --manifest <file> [--profile <id>]
  contextcake pack update <directory> --manifest <file> --apply [--level <n>]
  contextcake pack list --manifest <file>
  contextcake pack rollback <id> --manifest <file> [--profile <id>] [--version <semver>]
  contextcake pack remove <id> --manifest <file> [--profile <id>]

Install and update verify a content-only Pack and retain immutable local versions.
Update previews a file-level diff without writing; repeat it with --apply to switch.
Remove detaches the layer but keeps every downloaded version. Use --packs-dir to
override the manifest-adjacent Pack store.
`);
}
