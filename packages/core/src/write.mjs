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
import { assertInsideRoot, writeFileInRoot } from "./capture.mjs";
import { withManifestLock } from "./manifest.mjs";
import { loadProfileRuntime } from "./profile-runtime.mjs";
import { normalizeConceptId } from "./sources/okf-local.mjs";

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
  const dryRun = args["dry-run"] === true || args["dry-run"] === "true";
  const date = new Date().toISOString().slice(0, 10);
  const results = withManifestLock(args.manifest, () => {
    const runtime = loadProfileRuntime(args.manifest, {
      requestedProfile: args.profile ?? null,
      cwd: process.cwd(),
    });
    // The top of the cascade is whatever the profile's highest level IS — over
    // every layer, before the eligibility filter below drops the ones this
    // tool cannot write to. A hand-authored 5/4 or a 2/0 manifest with no
    // personal layer has a top too; the literal `3` this replaced only knew
    // the documented default.
    const topLevel = topCascadeLevel(runtime.selection.layers);
    const layers = runtime.selection.layers
      // Plain Markdown folders and live repositories are read/capture surfaces,
      // not batch-ingest targets. Only curated OKF layers are writable here.
      .filter((layer) => (layer.source ?? "okf-local") === "okf-local" && layer.live !== true)
      .filter((layer) => typeof layer.path === "string")
      .map((layer) => ({
        name: layer.name,
        level: Number(layer.level),
        root: path.resolve(runtime.manifestDir, layer.path),
      }));

    const targetLayer = selectTargetLayer(layers, args["target-layer"], topLevel);
    return writeSignals(signals, targetLayer, { dryRun, date });
  });

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
  if (typeof destination !== "string") throw new Error(`Signal ${signal.id ?? "<unknown>"} destination must be a concept id.`);
  const normalizedDestination = normalizeConceptId(destination);

  // review_required goes into _review/ staging; team_candidate goes directly.
  const relativeConcept = isReview
    ? path.posix.join("_review", normalizedDestination.replace(/^review\//, ""))
    : normalizedDestination;
  const relativeFile = `${relativeConcept}.md`;
  let conceptFile = path.resolve(targetLayer.root, relativeFile);

  if (!dryRun) {
    conceptFile = assertInsideRoot(targetLayer.root, relativeFile);
    if (fs.existsSync(conceptFile)) {
      const stat = fs.lstatSync(conceptFile);
      if (stat.isSymbolicLink()) throw new Error(`Refusing to inspect or overwrite a symlink: ${relativeFile}`);
      if (!stat.isFile()) throw new Error(`Write target is not a regular file: ${relativeFile}`);
      return { signalId: signal.id, status: "skipped", reason: "already exists", path: conceptFile };
    }
  }

  const content = generateConcept(signal, date, isReview);

  if (!dryRun) {
    writeFileInRoot(targetLayer.root, relativeFile, content);
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

// The highest level any layer in the selected profile carries — the top of
// the cascade, whatever integer that happens to be.
export function topCascadeLevel(layers) {
  let top = Number.NEGATIVE_INFINITY;
  for (const layer of layers) {
    const level = Number(layer.level);
    if (Number.isFinite(level) && level > top) top = level;
  }
  return top;
}

/**
 * Which eligible layer a batch write lands in when the caller didn't say.
 * The top of the cascade is the personal layer by convention, and captured
 * signals are shared context, so the default is the highest eligible layer
 * BELOW the top — team on a 3/2/0 manifest, 4 on a hand-authored 5/4, the 0
 * layer on a 2/0 manifest that has no personal layer at all. `topLevel` is
 * measured over every layer in the profile (not just the eligible ones), so a
 * Markdown-folder personal layer still counts as the top even though it can
 * never be a target. Only when nothing sits below the top does the top layer
 * itself get written, with a warning.
 *
 * The chosen default is ALWAYS named on stderr, with the rule: it used to be
 * the literal 3, and a manifest with no personal layer (team 2 / company 0)
 * changed destination when the rule did — silently, unless it is said.
 */
export function selectTargetLayer(layers, requested, topLevel = topCascadeLevel(layers)) {
  if (layers.length === 0) throw new Error("Manifest contains no layers.");

  if (requested) {
    const layer = layers.find((l) => l.name === requested);
    if (!layer) throw new Error(`Layer not found in manifest: ${requested}. Available: ${layers.map((l) => l.name).join(", ")}`);
    return layer;
  }

  const sorted = [...layers].sort((a, b) => b.level - a.level);
  const belowTop = sorted.find((l) => l.level < topLevel);
  if (belowTop) {
    console.warn(`writing to "${belowTop.name}" — the highest layer below the top of the cascade; pass --target-layer to choose`);
    return belowTop;
  }

  console.warn(`writing to "${sorted[0].name}" — only the top-of-cascade layer is writable; pass --target-layer to choose`);
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
  node write.mjs --signals signals.json --manifest manifest.json [--profile <id>]
  node write.mjs --signals signals.json --manifest manifest.json --target-layer team
  node write.mjs --signals signals.json --manifest layers.json --dry-run

Writes captured OKF concepts from ingest signals into a curated local OKF layer.
  team_candidate  → written directly to the target layer directory
  review_required → staged under _review/ for human approval
  ignore / local  → skipped

Default target layer: the highest eligible layer below the top of the cascade
(team, group, or company — never the top layer unless it is the only one).
Pass --target-layer <name> to specify explicitly. Profile selection order is
explicit --profile, deepest project mapping for the current working directory,
then default. Plain Markdown-folder sources and live layers are never batch
write targets; traversal and symlink destinations are rejected.
`);
}
