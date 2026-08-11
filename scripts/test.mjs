#!/usr/bin/env node
// The repo's test gate. Replaces what used to be a 32-command `&&` chain on one
// line of package.json — which could not run a subset, and hid every failure
// after the first.
//
//   node scripts/test.mjs                 # everything, in order
//   node scripts/test.mjs unit            # one group
//   node scripts/test.mjs unit integration
//   node scripts/test.mjs --only search   # every suite whose name matches
//   node scripts/test.mjs --list          # what would run
//   node scripts/test.mjs --bail          # stop at the first failure
//
// Suites run sequentially: several bind 127.0.0.1 or shell out to git, and
// running them concurrently would trade a slow gate for a flaky one. The
// ordering below is the ordering the chain had — cheap and broad first, so a
// broken build fails in seconds rather than minutes.
//
// Default is continue-on-failure with a summary at the end. One run should tell
// you everything that is broken, not just the first thing.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sh = (file) => ({ command: "bash", args: [`packages/core/tests/${file}`] });
const node = (file) => ({ command: process.execPath, args: ["--test", `packages/core/tests/${file}`] });

const SUITES = [
  // Broad shape checks. If the cascade itself is broken these fail first.
  { group: "integration", name: "smoke", ...sh("smoke-test.sh") },
  { group: "integration", name: "resolver", ...sh("resolver-test.sh") },
  { group: "integration", name: "sources", ...sh("source-test.sh") },
  { group: "integration", name: "files-source", ...sh("files-source-test.sh") },
  { group: "integration", name: "github-source", ...sh("github-source-test.sh") },

  // Pure units. Fast, no network, no temp dirs.
  { group: "unit", name: "tokens", ...node("tokens.test.mjs") },
  { group: "unit", name: "git-auth", ...node("git-auth.test.mjs") },
  { group: "unit", name: "manifest", ...node("manifest.test.mjs") },
  { group: "unit", name: "index-keys", ...node("index-keys.test.mjs") },
  { group: "unit", name: "memory-pressure", ...node("memory-pressure.test.mjs") },
  { group: "unit", name: "cache-source", ...node("cache-source.test.mjs") },
  { group: "unit", name: "layer-files", ...node("layer-files.test.mjs") },
  { group: "unit", name: "search", ...node("search.test.mjs") },
  { group: "unit", name: "conflict-resolutions", ...node("conflict-resolutions.test.mjs") },
  { group: "unit", name: "discrepancies", ...node("discrepancies.test.mjs") },
  { group: "unit", name: "discrepancy-transactions", ...node("discrepancy-transactions.test.mjs") },

  // Write path, sync, and the servers. These bind ports and shell out to git.
  { group: "integration", name: "profile-runtime", ...sh("profile-runtime-test.sh") },
  { group: "integration", name: "pack", ...sh("pack-test.sh") },
  { group: "integration", name: "git-sync", ...sh("git-sync-test.sh") },
  { group: "integration", name: "capture", ...sh("capture-test.sh") },
  { group: "integration", name: "team-sync-mcp", ...sh("team-sync-mcp-test.sh") },
  { group: "integration", name: "playground", ...sh("playground-test.sh") },
  { group: "integration", name: "service", ...sh("service-test.sh") },
  { group: "integration", name: "mcp-respawn", ...sh("mcp-respawn-test.sh") },
  { group: "integration", name: "setup-robustness", ...sh("setup-robustness-test.sh") },

  // Retrieval quality is measured, not asserted: a ranking change that loses
  // recall fails here rather than shipping quietly.
  {
    group: "eval",
    name: "retrieval-eval",
    command: process.execPath,
    args: ["packages/core/eval/run.mjs"],
  },

  // Release plumbing — the workflows and the metrics script.
  {
    group: "release",
    name: "app-metrics",
    command: process.execPath,
    args: ["--test", "scripts/tests/app-metrics.test.mjs"],
  },
  {
    group: "release",
    name: "release-surfaces",
    command: process.execPath,
    args: ["--test", "scripts/tests/release-workflow.test.mjs", "scripts/tests/verify-release-surfaces.test.mjs"],
  },

  // Indexing behaviour over time. Slowest in the suite by design — these wait
  // out real quiet periods and real concurrency.
  { group: "slow", name: "index-stability", ...sh("index-stability-test.sh") },
  { group: "slow", name: "index-lifecycle", ...sh("index-lifecycle-test.sh") },
  { group: "slow", name: "index-concurrency", ...sh("index-concurrency-test.sh") },
  { group: "slow", name: "graph-latency", ...sh("graph-latency-test.sh") },
];

const GROUPS = [...new Set(SUITES.map((suite) => suite.group))];

function parseArgs(argv) {
  const groups = [];
  let only = null;
  let bail = false;
  let list = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--bail") bail = true;
    else if (arg === "--list") list = true;
    else if (arg === "--only") only = argv[++i];
    else if (arg.startsWith("--only=")) only = arg.slice("--only=".length);
    else if (arg.startsWith("-")) fail(`Unknown flag: ${arg}`);
    else if (GROUPS.includes(arg)) groups.push(arg);
    else fail(`Unknown group: ${arg}. Known groups: ${GROUPS.join(", ")}`);
  }
  return { groups, only, bail, list };
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

function select({ groups, only }) {
  let selected = SUITES;
  if (groups.length) selected = selected.filter((suite) => groups.includes(suite.group));
  if (only) selected = selected.filter((suite) => suite.name.includes(only));
  return selected;
}

function run(suite) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(suite.command, suite.args, { cwd: ROOT, stdio: "inherit", env: process.env });
    child.on("error", (error) => resolve({ suite, ok: false, ms: Date.now() - started, reason: error.message }));
    child.on("close", (code, signal) => {
      const reason = signal ? `killed by ${signal}` : `exit ${code}`;
      resolve({ suite, ok: code === 0 && !signal, ms: Date.now() - started, reason });
    });
  });
}

const options = parseArgs(process.argv.slice(2));
const suites = select(options);

if (!suites.length) fail("No suites matched.");

if (options.list) {
  for (const suite of suites) console.log(`${suite.group.padEnd(12)} ${suite.name}`);
  process.exit(0);
}

const results = [];
for (const [index, suite] of suites.entries()) {
  console.log(`\n─── [${index + 1}/${suites.length}] ${suite.group}: ${suite.name} ${"─".repeat(20)}`);
  const result = await run(suite);
  results.push(result);
  if (!result.ok && options.bail) break;
}

const failed = results.filter((result) => !result.ok);
const total = results.reduce((sum, result) => sum + result.ms, 0);

console.log(`\n${"═".repeat(60)}`);
console.log(`${results.length - failed.length}/${suites.length} suites passed in ${(total / 1000).toFixed(1)}s`);

if (failed.length) {
  console.log("\nFailed:");
  for (const result of failed) console.log(`  ${result.suite.group}/${result.suite.name} (${result.reason})`);
  const skipped = suites.length - results.length;
  if (skipped) console.log(`\n${skipped} suite(s) not run (--bail).`);
  console.log(`\nRerun one with: node scripts/test.mjs --only ${failed[0].suite.name}`);
  process.exit(1);
}
