#!/usr/bin/env node

// Deterministic Stop-hook nudge: if the session's recent assistant output
// looks capture-worthy (root cause found, decision made, spec written) and
// no log_capture call happened, continue the agent ONCE with a reminder to
// offer a capture. stop_hook_active is the loop guard — when set, this hook
// has already fired for this stop and must allow the stop. No model calls.

import fs from "node:fs";

let raw = "";
try {
  raw = fs.readFileSync(0, "utf8");
} catch {
  process.exit(0);
}

let input = {};
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

// Loop guard: never block a stop that already went through this hook.
if (input.stop_hook_active) process.exit(0);

const transcriptPath = input.transcript_path;
if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

// Read only the tail — recent turns are what matter for the nudge.
let tail = "";
try {
  const content = fs.readFileSync(transcriptPath, "utf8");
  tail = content.slice(-40000);
} catch {
  process.exit(0);
}

// Already captured (or offered): nothing to nudge.
if (tail.includes("log_capture")) process.exit(0);

const captureWorthy = /root cause|resolved|fixed the|decided to|gotcha|wrote (a )?spec/i;
if (!captureWorthy.test(tail)) process.exit(0);

process.stdout.write(JSON.stringify({
  decision: "block",
  reason:
    "If this session produced a resolution, decision, gotcha, or artifact worth sharing with the team, offer log_capture now (show the preview; confirm only on an explicit yes). Otherwise finish.",
}));
