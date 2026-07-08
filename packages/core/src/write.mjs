#!/usr/bin/env node

// Write captured OKF concepts from ingest signals into a target layer bundle.
// team_candidate signals are written directly to the target layer.
// review_required signals are staged under _review/ for human approval.
// Dependency-free.
//
// Usage:
//   node write.mjs --signals signals.json --manifest layers.json
//   node write.mjs --signals signals.json --manifest layers.json --target-layer team
//   node write.mjs --signals signals.json --manifest layers.json --dry-run

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (isMainModule(import.meta.url)) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!args.signals) throw new Error("--signals <file> is required");
  if (!args.manifest) throw new Error("--manifest <file> is required");

  const signals = readJson(args.signals);
  const manifest = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
  const layers = (manifest.layers ?? []).map((layer) => ({
    name: layer.name,
    level: Number(layer.level),
    root: path.resolve(path.dirname(args.manifest), layer.path),
  }));

  const targetLayer = selectTargetLayer(layers, args["target-layer"]);
  const dryRun = args["dry-run"] === true || args["dry-run"] === "true";
  const date = new Date().toISOString().slice(0, 10);

  const results = writeSignals(signals, targetLayer, { dryRun, date });

  const written = results.filter((r) => r.status === "written");
  const staged = results.filter((r) => r.status === "staged");
  const skipped = results.filter((r) => r.status === "skipped");

  if (dryRun) {
    console.log("[dry-run] No files written.\n");
  }

  for (const r of [...written, ...staged]) {
    console.log(`${dryRun ? "[dry-run] " : ""}${r.status === "staged" ? "staged" : "wrote"}: ${r.path}`);
  }
  for (const r of skipped) {
    console.log(`skipped (${r.reason}): ${r.signalId}`);
  }

  console.log(
    `\n${dryRun ? "[dry-run] " : ""}Done: ${written.length} written, ${staged.length} staged for review, ${skipped.length} skipped.`
  );
}

// Pure core — no I/O side effects when dryRun is true.
export function writeSignals(signals, targetLayer, { dryRun = false, date = "2026-01-01" } = {}) {
  const signalList = asArray(signals.signals ?? signals);
  return signalList.map((signal) => processSignal(signal, targetLayer, { dryRun, date }));
}

function processSignal(signal, targetLayer, { dryRun, date }) {
  if (signal.route === "ignore" || signal.route === "local") {
    return { signalId: signal.id, status: "skipped", reason: signal.route };
  }

  const isReview = signal.route === "review_required";
  const destination = signal.destination;

  if (!destination) {
    return { signalId: signal.id, status: "skipped", reason: "no destination" };
  }

  // review_required goes into _review/ staging; team_candidate goes directly.
  const conceptPath = isReview
    ? path.join(targetLayer.root, "_review", destination.replace(/^review\//, ""))
    : path.join(targetLayer.root, destination);

  const conceptFile = `${conceptPath}.md`;

  if (!dryRun && fs.existsSync(conceptFile)) {
    return { signalId: signal.id, status: "skipped", reason: "already exists", path: conceptFile };
  }

  const content = generateConcept(signal, date, isReview);

  if (!dryRun) {
    fs.mkdirSync(path.dirname(conceptFile), { recursive: true });
    fs.writeFileSync(conceptFile, content, "utf8");
  }

  return {
    signalId: signal.id,
    status: isReview ? "staged" : "written",
    path: conceptFile,
  };
}

function generateConcept(signal, date, isReview) {
  const type = inferType(signal.destination);
  const reasonLines = (signal.reasons ?? []).map((r) => `- ${r}`).join("\n") || "- No specific signals recorded.";
  const reviewNote = isReview
    ? `\n## Review Required {#review-required}\n\n> This concept was flagged for human review before publishing to shared context.\n> Approve by moving this file out of \`_review/\` into the appropriate layer directory.\n`
    : "";

  return `---
type: ${type}
title: ${signal.title}
source: ${signal.repo}
draft: true
updated: ${date}
---

# ${signal.title}

> Auto-captured from ${signal.source ?? "repo signal"} in \`${signal.repo}\`.
${reviewNote}
## Context {#context}

${signal.action ?? "Awaiting description."}

## Signals {#signals}

${reasonLines}
`;
}

function inferType(destination) {
  if (!destination) return "context";
  if (destination.startsWith("decisions/")) return "decision";
  if (destination.startsWith("runbooks/")) return "runbook";
  if (destination.startsWith("interfaces/")) return "interface";
  if (destination.startsWith("systems/")) return "system";
  if (destination.startsWith("review/")) return "context";
  return "context";
}

function selectTargetLayer(layers, requested) {
  if (layers.length === 0) throw new Error("Manifest contains no layers.");

  if (requested) {
    const layer = layers.find((l) => l.name === requested);
    if (!layer) throw new Error(`Layer not found in manifest: ${requested}. Available: ${layers.map((l) => l.name).join(", ")}`);
    return layer;
  }

  // Default: highest level that isn't personal (< 3), or level 3 if that's the only option.
  const sorted = [...layers].sort((a, b) => b.level - a.level);
  const nonPersonal = sorted.find((l) => l.level < 3);
  if (nonPersonal) return nonPersonal;

  console.warn("Warning: only a personal layer (level 3) is available. Pass --target-layer to choose.");
  return sorted[0];
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--dry-run") parsed["dry-run"] = true;
    else if (arg.startsWith("--")) {
      parsed[arg.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node write.mjs --signals signals.json --manifest layers.json
  node write.mjs --signals signals.json --manifest layers.json --target-layer team
  node write.mjs --signals signals.json --manifest layers.json --dry-run

Writes captured OKF concepts from ingest signals into a target layer bundle.
  team_candidate  → written directly to the target layer directory
  review_required → staged under _review/ for human approval
  ignore / local  → skipped

Default target layer: highest level < 3 in the manifest (team, group, or company).
Pass --target-layer <name> to specify explicitly.
`);
}
