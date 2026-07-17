#!/usr/bin/env node

// Aggregates the live layer into control-surface data: an activity feed of
// captures (including archived ones — this reads raw disk, deliberately
// bypassing the read-time decay filter) and reuse metrics computed from the
// per-author telemetry NDJSON logs. Content-free by construction: everything
// here is ids, kinds, authors, and timestamps.
//
// Usage:
//   node team-activity.mjs --live-root <dir> --out apps/control-surface/team-activity.json
//   [--curated-root <dir>]   also list pending promotion requests
//   [--retention-days 14]

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseConcept } from "./sources/okf-local.mjs";

const DAY_MS = 86400000;

if (isMainModule(import.meta.url)) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args["live-root"]) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  const result = buildActivity({
    liveRoot: path.resolve(args["live-root"]),
    curatedRoot: args["curated-root"] ? path.resolve(args["curated-root"]) : null,
    retentionDays: Number(args["retention-days"] ?? 14),
  });
  const json = JSON.stringify(result, null, 2);
  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), json);
    console.log(`Wrote ${args.out} (${result.feed.length} captures, ${result.metrics.crossBrainHits} cross-brain hits)`);
  } else {
    console.log(json);
  }
}

export function buildActivity({ liveRoot, curatedRoot = null, retentionDays = 14, now = Date.now }) {
  const feed = readFeed(liveRoot, retentionDays, now);
  const events = readTelemetry(liveRoot);
  const metrics = computeMetrics(events);
  const pendingPromotions = curatedRoot ? readPendingPromotions(curatedRoot) : [];
  return { generatedAt: new Date(now()).toISOString(), feed, metrics, pendingPromotions };
}

function readFeed(liveRoot, retentionDays, now) {
  const capturesDir = path.join(liveRoot, "captures");
  const rows = [];
  for (const filePath of walkMarkdown(capturesDir)) {
    try {
      const { frontmatter } = parseConcept(fs.readFileSync(filePath, "utf8"));
      const id = path.relative(liveRoot, filePath).split(path.sep).join("/").replace(/\.md$/i, "");
      const capturedTime = new Date(frontmatter.captured ?? "").getTime();
      rows.push({
        id,
        kind: frontmatter.kind ?? null,
        title: frontmatter.title ?? null,
        author: frontmatter.author ?? null,
        capturedAt: frontmatter.captured ?? null,
        status: frontmatter.status ?? null,
        archived: !Number.isNaN(capturedTime) && now() - capturedTime > retentionDays * DAY_MS,
      });
    } catch {
      console.error(`team-activity: skipping unparseable capture ${filePath}`);
    }
  }
  return rows.sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
}

function readTelemetry(liveRoot) {
  const telemetryDir = path.join(liveRoot, "telemetry");
  const events = [];
  if (!fs.existsSync(telemetryDir)) return events;
  for (const author of fs.readdirSync(telemetryDir)) {
    const authorDir = path.join(telemetryDir, author);
    if (!fs.statSync(authorDir).isDirectory()) continue;
    for (const file of fs.readdirSync(authorDir)) {
      if (!file.endsWith(".ndjson")) continue;
      const lines = fs.readFileSync(path.join(authorDir, file), "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          console.error(`team-activity: skipping malformed telemetry line in ${author}/${file}`);
        }
      }
    }
  }
  return events;
}

function computeMetrics(events) {
  const confirms = events.filter((e) => e.event === "confirm");
  const promotes = events.filter((e) => e.event === "promote");
  const reuses = events.filter((e) => (e.event === "read" || e.event === "search_hit") && String(e.concept ?? "").startsWith("captures/"));

  const confirmByConcept = new Map();
  for (const c of confirms) {
    if (!confirmByConcept.has(c.concept)) confirmByConcept.set(c.concept, c);
  }

  let crossBrainHits = 0;
  const firstReuse = new Map(); // concept -> earliest cross-user reuse ts
  for (const r of reuses) {
    const confirm = confirmByConcept.get(r.concept);
    if (!confirm || r.user === confirm.user) continue;
    crossBrainHits += 1;
    const current = firstReuse.get(r.concept);
    if (!current || r.ts < current) firstReuse.set(r.concept, r.ts);
  }

  const reuseHours = [...firstReuse.entries()].map(([concept, ts]) => {
    const confirm = confirmByConcept.get(concept);
    return (new Date(ts).getTime() - new Date(confirm.ts).getTime()) / 3600000;
  });
  const promoteHours = promotes
    .filter((p) => confirmByConcept.has(p.concept))
    .map((p) => (new Date(p.ts).getTime() - new Date(confirmByConcept.get(p.concept).ts).getTime()) / 3600000);

  const volumeByWeek = {};
  for (const c of confirms) {
    const week = isoWeekStart(c.ts);
    volumeByWeek[week] = (volumeByWeek[week] ?? 0) + 1;
  }

  return {
    crossBrainHits,
    captureVolumeByWeek: volumeByWeek,
    medianTimeToFirstReuseHours: median(reuseHours),
    reviewThroughput: {
      confirmed: confirms.length,
      promoted: promotes.length,
      medianHoursToPromote: median(promoteHours),
    },
    activeAuthors: [...new Set(events.map((e) => e.user).filter(Boolean))].length,
  };
}

function readPendingPromotions(curatedRoot) {
  const dir = path.join(curatedRoot, "_review", "promotions");
  const rows = [];
  for (const filePath of walkMarkdown(dir)) {
    try {
      const { frontmatter } = parseConcept(fs.readFileSync(filePath, "utf8"));
      rows.push({
        reviewFile: path.relative(curatedRoot, filePath).split(path.sep).join("/"),
        promoteTo: frontmatter.promoteTo ?? null,
        promotedFrom: frontmatter.promotedFrom ?? null,
        kind: frontmatter.kind ?? null,
        author: frontmatter.author ?? null,
      });
    } catch {
      console.error(`team-activity: skipping unparseable promotion request ${filePath}`);
    }
  }
  return rows;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return Math.round(value * 100) / 100;
}

function isoWeekStart(ts) {
  const date = new Date(ts);
  const day = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - day);
  return date.toISOString().slice(0, 10);
}

function walkMarkdown(root) {
  if (!root || !fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
      if (dirent.name.startsWith(".")) continue;
      const fullPath = path.join(current, dirent.name);
      if (dirent.isDirectory()) stack.push(fullPath);
      else if (dirent.isFile() && dirent.name.endsWith(".md")) files.push(fullPath);
    }
  }
  return files.sort();
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
    else if (arg.startsWith("--")) {
      parsed[arg.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node team-activity.mjs --live-root <dir> [--out <file>] [--curated-root <dir>] [--retention-days 14]

Aggregates live-layer captures and telemetry into control-surface data:
activity feed (archived captures included), cross-brain hits, capture volume,
time-to-first-reuse, and review throughput. Ids and timestamps only — never
capture content.
`);
}
