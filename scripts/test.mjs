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

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
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
  { group: "unit", name: "walk", ...node("walk.test.mjs") },
  { group: "unit", name: "snapshot-reuse", ...node("snapshot-reuse.test.mjs") },
  { group: "unit", name: "memory-pressure", ...node("memory-pressure.test.mjs") },
  { group: "unit", name: "cache-source", ...node("cache-source.test.mjs") },
  { group: "unit", name: "layer-files", ...node("layer-files.test.mjs") },
  { group: "unit", name: "search", ...node("search.test.mjs") },
  { group: "unit", name: "search-index", ...node("search-index.test.mjs") },
  { group: "unit", name: "token-count-cache", ...node("token-count-cache.test.mjs") },
  { group: "unit", name: "conflict-resolutions", ...node("conflict-resolutions.test.mjs") },
  { group: "unit", name: "sidecar-state", ...node("sidecar-state.test.mjs") },
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
  { group: "slow", name: "resolve-all-scale", ...sh("resolve-all-scale-test.sh") },
  { group: "slow", name: "index-incremental", ...sh("index-incremental-test.sh") },
  { group: "slow", name: "index-scale", ...sh("index-scale-test.sh") },
  { group: "slow", name: "index-retry", ...sh("index-retry-test.sh") },
  { group: "slow", name: "index-controls", ...sh("index-controls-test.sh") },
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
    // An empty `--only` must fail loudly, in both spellings. `only` was tested
    // for truthiness downstream, so a missing value (`--only` at the end of
    // argv) or an empty one (`--only=`) skipped the filter and quietly ran all
    // 32 suites — the opposite of what was asked for, and slow enough that you
    // only notice after the gate has been running for two minutes.
    else if (arg === "--only" || arg.startsWith("--only=")) {
      only = arg === "--only" ? argv[++i] : arg.slice("--only=".length);
      if (!only) fail("--only needs a suite name. Try --list to see them.");
    }
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

// A test file on disk that no suite names would never run, and nothing would
// say so — the gate would just get quietly narrower. That is not theoretical:
// sidecar-state.test.mjs landed on main while this runner was being written,
// and an unguarded merge would have dropped it silently. Checked only on a full
// run, so a filtered run stays fast.
function assertEverySuiteRegistered() {
  const registered = new Set(SUITES.flatMap((suite) => suite.args.filter((arg) => arg.includes("/"))));
  const orphans = [];
  for (const dir of ["packages/core/tests", "scripts/tests"]) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir))) {
      if (!/(-test\.sh|\.test\.mjs)$/.test(entry)) continue;
      const rel = `${dir}/${entry}`;
      if (!registered.has(rel)) orphans.push(rel);
    }
  }
  if (orphans.length) {
    fail(
      `These test files exist but no suite runs them:\n${orphans.map((o) => `  ${o}`).join("\n")}\n` +
        "Add them to SUITES in scripts/test.mjs.",
    );
  }
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

// One NUL byte makes grep call a whole text file binary: it reports no matches
// rather than an error, so the file drops out of every search silently. Two of
// them hid service.mjs and main.mjs until #132; that cost a PR to find, and
// nothing stopped the next one. Cheap to check, so check it.
function assertNoNulBytes() {
  const listed = spawnSync("git", ["ls-files", "-z", "*.mjs", "*.js", "*.cjs", "*.ts", "*.tsx", "*.md", "*.json"], {
    cwd: ROOT,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) return; // not a git checkout — not this gate's problem
  const offenders = [];
  for (const rel of listed.stdout.toString("utf8").split("\0")) {
    if (!rel) continue;
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    if (fs.readFileSync(full).includes(0)) offenders.push(rel);
  }
  if (offenders.length) {
    fail(
      `These text files contain a NUL byte, which makes grep skip them entirely:\n` +
        `${offenders.map((o) => `  ${o}`).join("\n")}\n` +
        `Strip it: LC_ALL=C tr -d '\\000' < FILE > FILE.tmp && mv FILE.tmp FILE`,
    );
  }
}

const options = parseArgs(process.argv.slice(2));
const suites = select(options);

if (!options.groups.length && !options.only) {
  assertEverySuiteRegistered();
  assertNoNulBytes();
}
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
