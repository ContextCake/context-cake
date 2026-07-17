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
const MAX_STAGED = 256;
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
  else {
    // Links land unquoted inside the `links: [...]` frontmatter line, so a
    // newline or bracket would inject arbitrary frontmatter keys (author,
    // status, promoteTo). Restrict to a safe reference charset.
    for (const link of links) {
      if (typeof link !== "string") { errors.push("each link must be a string"); continue; }
      if (/[\r\n\[\],]/.test(link)) errors.push(`link "${link.slice(0, 40)}" contains a disallowed character (newline, bracket, or comma)`);
    }
  }

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
//
// A BEST-EFFORT backstop, not a guarantee. The authoritative control is the
// human show-before-share preview; this catches the common, high-signal
// formats so an obvious secret never slips through unattended. It will miss
// novel or low-entropy secrets and most PII — do not treat a pass as "clean."
const CREDENTIAL_PATTERNS = [
  { name: "aws-access-key", regex: /AKIA[0-9A-Z]{16}/ },
  { name: "github-token", regex: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "slack-token", regex: /xox[baprs]-/ },
  { name: "stripe-key", regex: /[sr]k_live_[A-Za-z0-9]{16,}/ },
  { name: "google-api-key", regex: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "jwt", regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "bearer-token", regex: /bearer\s+[A-Za-z0-9._-]{20,}/i },
  { name: "private-key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // Env/assignment style, quoted OR unquoted: quoted needs 12+ chars; unquoted
  // needs a 20+ char no-whitespace blob so ordinary prose ("token = expired")
  // doesn't trip it.
  { name: "generic-secret", regex: /(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*(['"][^'"]{12,}|[A-Za-z0-9+/_=-]{20,})/i },
];

export function scanForCredentials(text) {
  return CREDENTIAL_PATTERNS.some((p) => p.regex.test(String(text ?? "")));
}

function credentialPatternName(text) {
  const hit = CREDENTIAL_PATTERNS.find((p) => p.regex.test(String(text ?? "")));
  return hit ? hit.name : null;
}

// ---- routing ---------------------------------------------------------------------

const policyCache = new Map();
function loadPolicy(policyPath) {
  if (!policyCache.has(policyPath)) policyCache.set(policyPath, JSON.parse(fs.readFileSync(policyPath, "utf8")));
  return policyCache.get(policyPath);
}

export function classifyCapture(capture, policyPath = defaultCapturePolicyPath) {
  const policy = loadPolicy(policyPath);
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

// Full canonical section order per kind (required + optional) so an optional
// section like `attempts` renders in its logical place, not after `fix`.
const SECTION_ORDER = {
  investigation: ["problem", "attempts", "root-cause", "fix"],
  decision: ["choice", "alternatives", "why"],
  gotcha: ["body"],
  artifact: ["summary", "pointer"],
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
  // Defense in depth (validateCapture already rejects these chars): strip any
  // frontmatter-breaking characters so a link can never inject a new key.
  const safeLinks = (capture.links ?? []).map((l) => String(l).replace(/[\r\n\[\],]/g, " ").trim()).filter(Boolean);
  if (safeLinks.length > 0) lines.push(`links: [${safeLinks.join(", ")}]`);
  lines.push("---", "", `# ${String(capture.title).replace(/\s*[\r\n]+\s*/g, " ")}`, "");
  // Canonical order first, then any extra sections the caller supplied.
  const ordered = SECTION_ORDER[capture.kind] ?? [];
  const sectionKeys = [...ordered, ...Object.keys(capture.sections ?? {}).filter((k) => !ordered.includes(k))];
  for (const key of sectionKeys) {
    const text = capture.sections?.[key];
    if (!text) continue;
    const heading = HEADINGS[key] ?? key.replace(/(^|-)([a-z])/g, (_, sep, ch) => (sep ? " " : "") + ch.toUpperCase()).trim();
    lines.push(`## ${heading} {#${key}}`, "", text.trim(), "");
  }
  return lines.join("\n");
}

// ---- path safety -------------------------------------------------------------------

// Validates that relFilePath stays inside root and returns the absolute target.
// Rejects, in order: lexical traversal (before any fs touch), then — after the
// parent dir is created — a symlinked parent that escapes root. The final
// component is handled at write time by writeFileInRoot (O_NOFOLLOW).
export function assertInsideRoot(root, relFilePath) {
  const target = path.resolve(root, relFilePath);
  const rel = path.relative(root, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes live root: ${relFilePath}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const realDir = fs.realpathSync(path.dirname(target));
  const realRoot = fs.realpathSync(root);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
    throw new Error(`Path escapes live root: ${relFilePath}`);
  }
  return target;
}

// Writes inside root without following a symlinked final component. O_NOFOLLOW
// makes open() fail with ELOOP if `target` is a symlink, closing the
// dangling-symlink escape (a teammate committing captures/x.md -> ~/.ssh/...
// so a confirm/promote write lands outside the repo). Race-free vs. lstat.
export function writeFileInRoot(root, relFilePath, data) {
  const target = assertInsideRoot(root, relFilePath);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
  let fd;
  try {
    fd = fs.openSync(target, flags, 0o644);
  } catch (error) {
    if (error.code === "ELOOP") throw new Error(`Refusing to write through a symlink: ${relFilePath}`);
    throw error;
  }
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
  return target;
}

// Telemetry is append-only, but it is still a write into a team-controlled
// repository. Keep the same final-component symlink protection as captures.
export function appendFileInRoot(root, relFilePath, data) {
  const target = assertInsideRoot(root, relFilePath);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW;
  let fd;
  try {
    fd = fs.openSync(target, flags, 0o644);
  } catch (error) {
    if (error.code === "ELOOP") throw new Error(`Refusing to write through a symlink: ${relFilePath}`);
    throw error;
  }
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
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
  // Bound the in-memory staging map so a spamming session can't grow it without
  // limit; sweep() already drops expired entries, this caps live ones.
  if (staged.size >= MAX_STAGED) {
    const oldest = [...staged.entries()].sort((a, b) => a[1].stagedAt - b[1].stagedAt)[0];
    if (oldest) staged.delete(oldest[0]);
  }
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
  writeFileInRoot(root, `${id}.md`, renderCapture(entry.capture, { author: entry.author, capturedAt: entry.capturedAt }));

  const extraPaths = typeof onEvent === "function"
    ? (onEvent({ event: "confirm", concept: id, captureKind: entry.capture.kind, user: entry.author }) ?? [])
    : [];
  try {
    await commitPaths(root, [`${id}.md`, ...extraPaths], `feat: capture ${id}`, { author: entry.author });
  } catch (error) {
    // Commit failed (lock contention, etc.): don't strand an untracked file
    // that a later commit could sweep up. The token is already consumed —
    // the caller re-stages.
    try { fs.rmSync(path.join(root, `${id}.md`), { force: true }); } catch { /* best effort */ }
    throw error;
  }
  const pushed = await push(root);
  return { id, pushed: pushed.pushed === true, ...(pushed.queued ? { queued: true } : {}) };
}
