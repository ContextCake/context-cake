#!/usr/bin/env node

// Ingests normalized repo signal events, classifies each through the shared
// context policy, and writes a dashboard-ready signals.json. Dependency-free.
//
// Usage:
//   node ingest.mjs --events mock-events.json --out control-surface/signals.json
//   node ingest.mjs --demo            # uses bundled mock-events.json
//
// A future GitHub adapter can produce the --events file via `gh api` once real
// repo names are known; this script only consumes already-normalized events.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyEvent, defaultPolicyPath, readJson } from "./classify-context.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultEventsPath = path.join(__dirname, "mock-events.json");
const defaultReposPath = path.join(__dirname, "repos.json");
const defaultOutPath = path.join(__dirname, "control-surface", "signals.json");

if (isMainModule(import.meta.url)) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const eventsPath = args.events ?? defaultEventsPath;
  const reposPath = args.repos ?? defaultReposPath;
  const outPath = args.out ?? defaultOutPath;
  const policy = readJson(args.policy ?? defaultPolicyPath);
  const repoConfig = readRepoConfig(reposPath);
  const events = asArray(readJson(eventsPath));

  const data = ingest(events, policy, repoConfig);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(data, null, 2)}\n`);

  const counts = countRoutes(data.signals);
  console.log(
    `Wrote ${data.signals.length} signals to ${outPath} ` +
      `(review_required: ${counts.review_required}, team_candidate: ${counts.team_candidate}, ` +
      `ignore: ${counts.ignore}, local: ${counts.local})`
  );
}

// Pure core: events + policy + repo config -> dashboard data shape.
export function ingest(events, policy, repoConfig = {}, now = null) {
  const owners = repoConfig.owners ?? {};
  const signals = asArray(events).map((event, index) => {
    const result = classifyEvent(event, policy);
    return {
      id: `sig-${index + 1}`,
      route: result.route,
      repo: result.repo,
      source: humanizeSource(event),
      title: result.title || `${result.repo} ${result.eventType}`,
      confidence: result.confidence,
      owner: owners[result.repo] ?? "Unassigned",
      destination: result.suggestedDestination,
      reasons: result.reasons,
      action: result.recommendedAction,
    };
  });

  return {
    generatedAt: now ?? new Date().toISOString(),
    selectedId: firstReviewId(signals) ?? signals[0]?.id ?? null,
    signals,
    repos: buildRepoSummaries(signals, repoConfig),
  };
}

function readRepoConfig(reposPath) {
  if (!fs.existsSync(reposPath)) {
    return { names: [], owners: {}, risks: {} };
  }
  const raw = readJson(reposPath);
  const repos = asArray(raw.repos);
  const owners = {};
  const risks = {};
  for (const repo of repos) {
    if (!repo.name) continue;
    owners[repo.name] = asArray(repo.reviewOwners)[0] ?? "Unassigned";
    risks[repo.name] = asArray(repo.areas).join(", ");
  }
  return { names: repos.map((repo) => repo.name).filter(Boolean), owners, risks };
}

// Coverage is derived honestly from the signals themselves: the share of a
// repo's durable signals that were auto-captured rather than left awaiting
// review. No fabricated documentation metrics.
function buildRepoSummaries(signals, repoConfig) {
  const names = new Set([...(repoConfig.names ?? []), ...signals.map((s) => s.repo)]);
  return [...names].map((name) => {
    const repoSignals = signals.filter((s) => s.repo === name);
    const reviewCount = repoSignals.filter((s) => s.route === "review_required").length;
    const capturedCount = repoSignals.filter((s) => s.route === "team_candidate").length;
    const durable = reviewCount + capturedCount;
    const coverage = durable === 0 ? 0 : Math.round((capturedCount / durable) * 100);
    const risk = reviewCount > 0
      ? `${reviewCount} awaiting review`
      : repoSignals.length > 0
        ? "healthy"
        : "no recent signals";
    return { name, coverage, risk };
  });
}

function humanizeSource(event) {
  const source = String(event.source ?? "").toLowerCase();
  const type = String(event.type ?? "").toLowerCase();
  if (source === "pull_request" || type.includes("pr_") || type.includes("merge")) return "merged PR";
  if (source.includes("repeated") || type.includes("question")) return "repeated question";
  if (source.includes("changed_files") || source.includes("commit")) return "changed files";
  if (source.includes("incident")) return "incident note";
  if (source.includes("issue")) return "issue";
  if (source.includes("deploy")) return "deploy note";
  if (!source) return "repo signal";
  return source.replace(/_/g, " ");
}

function firstReviewId(signals) {
  return signals.find((signal) => signal.route === "review_required")?.id ?? null;
}

function countRoutes(signals) {
  const counts = { review_required: 0, team_candidate: 0, ignore: 0, local: 0 };
  for (const signal of signals) {
    counts[signal.route] = (counts[signal.route] ?? 0) + 1;
  }
  return counts;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function isMainModule(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return moduleUrl === pathToFileURL(entry).href;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--demo") {
      parsed.demo = true;
    } else if (arg.startsWith("--")) {
      parsed[arg.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node ingest.mjs --events mock-events.json --out control-surface/signals.json
  node ingest.mjs --demo

Classifies a list of normalized repo signal events and writes a dashboard-ready
signals.json (signals + per-repo coverage). Defaults: --events mock-events.json,
--repos repos.json, --out control-surface/signals.json.
`);
}
