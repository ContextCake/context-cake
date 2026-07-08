#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
export const defaultPolicyPath = path.join(packageRoot, "fixtures", "context-policy.json");

if (isMainModule(import.meta.url)) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const policy = readJson(args.policy ?? defaultPolicyPath);
  const event = args.demo ? demoEvent() : readEvent(args.event);
  const result = classifyEvent(event, policy);

  console.log(JSON.stringify(result, null, 2));
}

function isMainModule(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return moduleUrl === pathToFileURL(entry).href;
}

export function classifyEvent(event, policy) {
  const normalized = normalizeEvent(event);
  const matches = {
    reviewRequired: collectMatches(normalized, policy.reviewRequired),
    teamCandidate: collectMatches(normalized, policy.teamCandidate),
    ignore: collectMatches(normalized, policy.ignore),
  };

  const repeatedQuestionCount = Number(normalized.repeatedQuestionCount ?? 0);
  if (repeatedQuestionCount >= Number(policy.thresholds.repeatedQuestionCount ?? 3)) {
    matches.teamCandidate.push({
      kind: "signal",
      value: `repeated_question_count:${repeatedQuestionCount}`,
      weight: 3,
    });
  }

  const reviewScore = score(matches.reviewRequired);
  const teamScore = score(matches.teamCandidate);
  const ignoreScore = score(matches.ignore);

  let route = "local";
  let reviewRequired = false;
  let confidence = 0.45;
  const reasons = [];

  if (reviewScore > 0) {
    route = "review_required";
    reviewRequired = true;
    confidence = clamp(0.6 + reviewScore * 0.08, 0.6, 0.95);
    reasons.push(...formatReasons("review", matches.reviewRequired));
  } else if (teamScore > ignoreScore && teamScore > 0) {
    route = "team_candidate";
    confidence = clamp(0.55 + teamScore * 0.07, 0.55, 0.9);
    reasons.push(...formatReasons("team", matches.teamCandidate));
  } else if (ignoreScore > 0 && ignoreScore >= teamScore) {
    route = "ignore";
    confidence = clamp(0.55 + ignoreScore * 0.06, 0.55, 0.88);
    reasons.push(...formatReasons("ignore", matches.ignore));
  } else {
    reasons.push("No durable team-context signal detected.");
  }

  return {
    route,
    confidence: Number(confidence.toFixed(2)),
    reviewRequired,
    repo: normalized.repo,
    source: normalized.source,
    eventType: normalized.type,
    title: normalized.title,
    reasons,
    recommendedAction: recommendedAction(route, normalized),
    suggestedDestination: suggestedDestination(route, normalized),
  };
}

function normalizeEvent(event) {
  return {
    repo: event.repo ?? "unknown",
    source: event.source ?? "repo",
    type: event.type ?? "unknown",
    title: event.title ?? "",
    body: event.body ?? "",
    labels: array(event.labels).map((value) => value.toLowerCase()),
    paths: array(event.paths).map((value) => value.toLowerCase()),
    repeatedQuestionCount: event.repeatedQuestionCount ?? 0,
    raw: event,
  };
}

function collectMatches(event, ruleGroup = {}) {
  const text = `${event.title}\n${event.body}`.toLowerCase();
  const matches = [];

  for (const keyword of ruleGroup.keywords ?? []) {
    if (text.includes(keyword.toLowerCase())) {
      matches.push({ kind: "keyword", value: keyword, weight: keyword.includes(" ") ? 2 : 1 });
    }
  }

  for (const label of ruleGroup.labels ?? []) {
    if (event.labels.includes(label.toLowerCase())) {
      matches.push({ kind: "label", value: label, weight: 3 });
    }
  }

  for (const pathPrefix of ruleGroup.paths ?? []) {
    const normalizedPrefix = pathPrefix.toLowerCase();
    if (event.paths.some((changedPath) => changedPath === normalizedPrefix || changedPath.startsWith(normalizedPrefix))) {
      matches.push({ kind: "path", value: pathPrefix, weight: 2 });
    }
  }

  return matches;
}

function score(matches) {
  return matches.reduce((total, match) => total + match.weight, 0);
}

function formatReasons(prefix, matches) {
  return matches.map((match) => `${prefix}:${match.kind}:${match.value}`);
}

function recommendedAction(route, event) {
  if (route === "review_required") {
    return "Create a review item with source links and require an owner decision before writing shared context.";
  }
  if (route === "team_candidate") {
    return "Draft or update shared OKF context automatically, then show it in the captured feed.";
  }
  if (route === "ignore") {
    return "Do not store as team context; retain only normal repo history.";
  }
  return "Keep as local/session context unless repeated or manually promoted.";
}

function suggestedDestination(route, event) {
  const title = slugify(event.title || event.type || "context");
  if (route === "review_required") return `review/${event.repo}/${title}`;
  if (route === "ignore") return null;
  if (event.type.includes("incident")) return `runbooks/${title}`;
  if (event.labels.includes("decision") || event.body.toLowerCase().includes("adr")) return `decisions/${title}`;
  if (event.labels.includes("runbook") || event.body.toLowerCase().includes("runbook")) return `runbooks/${title}`;
  if (event.labels.includes("api-contract") || event.body.toLowerCase().includes("contract")) return `interfaces/${title}`;
  if (route === "team_candidate") return `systems/${event.repo}/${title}`;
  return null;
}

function readEvent(eventPath) {
  if (!eventPath) {
    throw new Error("Missing --event <file>. Use --demo for a sample classification.");
  }
  return readJson(eventPath);
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function demoEvent() {
  return {
    repo: "billing-api",
    source: "pull_request",
    type: "pr_merged",
    title: "Add retry runbook for payment webhook failures",
    body: "Documents the operational procedure after the incident follow-up.",
    labels: ["runbook", "incident"],
    paths: ["runbooks/payment-webhooks.md"],
    repeatedQuestionCount: 0
  };
}

function array(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "context";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
  node classify-context.mjs --event event.json
  node classify-context.mjs --demo

Classifies repo or team signals into ignore, local, team_candidate, or review_required.
`);
}
