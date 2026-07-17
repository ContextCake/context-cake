// Capture module: turns an agent-session payload into a shareable OKF capture
// in the live layer, through hard gates — schema validation, credential scan
// (reject, never redact), capture-policy routing — and a two-phase
// show-before-share flow: stageCapture renders a preview and returns a
// single-use token; confirmCapture (called only after the human approves)
// writes, commits, and pushes. Tokens live in memory per process with a
// 10-minute TTL, which is correct because the same MCP server process serves
// both phases.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { classifyEvent, slugify } from "./classify-context.mjs";
import { normalizeConceptId } from "./sources/okf-local.mjs";
import { runGit, commitPaths, push } from "./sources/git-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const defaultCapturePolicyPath = path.join(HERE, "..", "fixtures", "capture-policy.json");

const KINDS = {
  investigation: ["problem", "fix"],
  decision: ["choice", "why"],
  gotcha: ["body"],
  artifact: ["summary", "pointer"],
};
const MAX_FIELD = 16 * 1024;
const MAX_TOTAL = 64 * 1024;
const MAX_LINKS = 32;
const TOKEN_TTL_MS = 10 * 60 * 1000;

// ---- validation ---------------------------------------------------------------

export function validateCapture(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object") return { ok: false, errors: ["payload must be an object"] };

  const required = KINDS[payload.kind];
  if (!required) errors.push(`kind must be one of: ${Object.keys(KINDS).join(", ")}`);
  if (!payload.title || typeof payload.title !== "string") errors.push("title is required");

  const sections = payload.sections ?? {};
  if (typeof sections !== "object" || Array.isArray(sections)) {
    errors.push("sections must be an object of { key: text }");
  } else {
    for (const key of required ?? []) {
      if (!sections[key] || typeof sections[key] !== "string" || !sections[key].trim()) {
        errors.push(`kind "${payload.kind}" requires section "${key}"`);
      }
    }
    for (const [key, value] of Object.entries(sections)) {
      if (typeof value !== "string") errors.push(`section "${key}" must be a string`);
    }
  }

  const links = payload.links ?? [];
  if (!Array.isArray(links)) errors.push("links must be an array");
  else if (links.length > MAX_LINKS) errors.push(`links: at most ${MAX_LINKS} entries`);

  let total = 0;
  for (const value of [payload.title, payload.confidence, ...Object.values(sections), ...(Array.isArray(links) ? links : [])]) {
    if (typeof value !== "string") continue;
    total += value.length;
    if (value.length > MAX_FIELD) errors.push(`a field exceeds ${MAX_FIELD} bytes`);
  }
  if (total > MAX_TOTAL) errors.push(`total payload exceeds ${MAX_TOTAL} bytes`);

  return { ok: errors.length === 0, errors };
}

// ---- credential scan (hard reject, never redact) --------------------------------

const CREDENTIAL_PATTERNS = [
  { name: "aws-access-key", regex: /AKIA[0-9A-Z]{16}/ },
  { name: "github-token", regex: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "slack-token", regex: /xox[baprs]-/ },
  { name: "private-key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "generic-secret", regex: /(api[_-]?key|token|secret|password)\s*[:=]\s*['"][^'"]{12,}/i },
];

export function scanForCredentials(text) {
  return CREDENTIAL_PATTERNS.some((p) => p.regex.test(String(text ?? "")));
}

function credentialPatternName(text) {
  const hit = CREDENTIAL_PATTERNS.find((p) => p.regex.test(String(text ?? "")));
  return hit ? hit.name : null;
}

// ---- routing ---------------------------------------------------------------------

export function classifyCapture(capture, policyPath = defaultCapturePolicyPath) {
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  const body = Object.values(capture.sections ?? {}).join("\n");
  return classifyEvent(
    { title: capture.title ?? "", body, labels: [capture.kind], source: "agent-session", type: "capture" },
    policy,
  );
}

// ---- attribution -----------------------------------------------------------------

export async function resolveAuthor({ root, profileName }) {
  const name = await runGit(root, ["config", "user.name"], { allowFailure: true });
  if (name.ok && name.stdout !== "") return name.stdout;
  if (profileName) return profileName;
  throw new Error(
    "No author identity: set git identity in the live repo (git config user.name) or add git.profileName to the live layer — the pack skill prompts once.",
  );
}

// ---- rendering -------------------------------------------------------------------

const HEADINGS = {
  problem: "Problem", attempts: "Attempts", "root-cause": "Root cause", fix: "Fix",
  choice: "Choice", why: "Why", alternatives: "Alternatives",
  body: "Body", summary: "Summary", pointer: "Pointer",
};

// parseFrontmatter is line-based: values must be single-line, and values with
// ":" / "#" / quotes get wrapped so parseYamlScalar unwraps back to the original.
function fmValue(value) {
  const flat = String(value).replace(/\s*[\r\n]+\s*/g, " ").trim();
  if (/[:#]|^['"\s]|['"\s]$/.test(flat)) return `"${flat}"`;
  return flat;
}

export function renderCapture(capture, { author, capturedAt }) {
  const lines = [
    "---",
    `kind: ${capture.kind}`,
    `title: ${fmValue(capture.title)}`,
    `author: ${fmValue(author)}`,
    `captured: ${capturedAt}`,
    `status: unreviewed`,
  ];
  if (capture.confidence) lines.push(`confidence: ${fmValue(capture.confidence)}`);
  if ((capture.links ?? []).length > 0) lines.push(`links: [${capture.links.join(", ")}]`);
  lines.push("---", "", `# ${String(capture.title).replace(/\s*[\r\n]+\s*/g, " ")}`, "");
  for (const key of Object.keys(KINDS[capture.kind] ? { ...Object.fromEntries(KINDS[capture.kind].map((k) => [k, 1])), ...capture.sections } : capture.sections)) {
    const text = capture.sections[key];
    if (!text) continue;
    const heading = HEADINGS[key] ?? key.replace(/(^|-)([a-z])/g, (_, sep, ch) => (sep ? " " : "") + ch.toUpperCase()).trim();
    lines.push(`## ${heading} {#${key}}`, "", text.trim(), "");
  }
  return lines.join("\n");
}

// ---- path safety -------------------------------------------------------------------

// Rejects lexical traversal (normalizeConceptId) and symlinked escapes: after
// mkdir, the real parent directory must live inside the real root.
export function assertInsideRoot(root, relFilePath) {
  const target = path.resolve(root, relFilePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const realDir = fs.realpathSync(path.dirname(target));
  const realRoot = fs.realpathSync(root);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
    throw new Error(`Path escapes live root: ${relFilePath}`);
  }
  return target;
}

// ---- two-phase staging ---------------------------------------------------------------

const staged = new Map(); // token -> { capture, id, author, capturedAt, stagedAt }

function sweep(now) {
  for (const [token, entry] of staged) {
    if (now() - entry.stagedAt > TOKEN_TTL_MS) staged.delete(token);
  }
}

function uniqueId(root, kind, author, title) {
  const base = `captures/${kind}/${slugify(author)}--${slugify(title)}`;
  let candidate = base;
  let n = 1;
  const taken = (id) =>
    fs.existsSync(path.join(root, `${id}.md`)) || [...staged.values()].some((entry) => entry.id === id);
  while (taken(candidate)) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

export async function stageCapture(payload, ctx) {
  const { root, profileName = null, policyPath = defaultCapturePolicyPath, now = Date.now } = ctx;
  sweep(now);

  const validation = validateCapture(payload);
  if (!validation.ok) {
    const error = new Error(`Invalid capture: ${validation.errors.join("; ")}`);
    error.code = "InvalidCapture";
    throw error;
  }

  const author = await resolveAuthor({ root, profileName });
  const capturedAt = new Date(now()).toISOString();
  const rendered = renderCapture(payload, { author, capturedAt });

  const pattern = credentialPatternName(rendered);
  if (pattern) {
    const error = new Error(
      `Capture rejected: content matches a credential pattern (${pattern}). Remove the secret and retry — captures are never redacted-and-shared.`,
    );
    error.code = "CredentialDetected";
    throw error;
  }

  const routed = classifyCapture(payload, policyPath);
  if (routed.route === "ignore" || routed.route === "local") {
    return { staged: false, route: routed.route, reasons: routed.reasons };
  }

  const warnings = [];
  if (routed.route === "review_required") {
    warnings.push(`Flagged for review before promotion (${routed.reasons.join(", ")}). It will share as unreviewed either way — double-check the content.`);
  }

  const id = uniqueId(root, payload.kind, author, payload.title);
  const token = crypto.randomUUID();
  staged.set(token, { capture: payload, id, author, capturedAt, stagedAt: now() });

  const preview = warnings.length > 0 ? `> ⚠ ${warnings.join("\n> ⚠ ")}\n\n${rendered}` : rendered;
  return { staged: true, token, id, preview, warnings, route: routed.route };
}

export async function confirmCapture(token, ctx) {
  const { root, now = Date.now, onEvent = null } = ctx;
  sweep(now);

  const entry = staged.get(token);
  staged.delete(token); // single-use, consumed even if the write below fails
  if (!entry) throw new Error("Unknown, expired, or already-used staging token — stage the capture again.");

  // Re-check uniqueness at confirm time (a teammate's capture may have landed).
  const id = fs.existsSync(path.join(root, `${entry.id}.md`)) ? uniqueId(root, entry.capture.kind, entry.author, entry.capture.title) : entry.id;
  normalizeConceptId(id);
  const target = assertInsideRoot(root, `${id}.md`);
  fs.writeFileSync(target, renderCapture(entry.capture, { author: entry.author, capturedAt: entry.capturedAt }), "utf8");

  const extraPaths = typeof onEvent === "function"
    ? (onEvent({ event: "confirm", concept: id, captureKind: entry.capture.kind, user: entry.author }) ?? [])
    : [];
  await commitPaths(root, [`${id}.md`, ...extraPaths], `feat: capture ${id}`, { author: entry.author });
  const pushed = await push(root);
  return { id, pushed: pushed.pushed === true, ...(pushed.queued ? { queued: true } : {}) };
}
