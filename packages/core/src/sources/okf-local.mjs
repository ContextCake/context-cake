// OKF-local source adapter: reads an OKF bundle (git repo of markdown + YAML
// frontmatter) from disk. Owns all OKF parsing. Implements the source contract:
//   loadConcept(id) -> { frontmatter, sections } | null
//   listConceptIds() -> string[]
//   sync() -> drops the commit-date memo      close() -> noop

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveSettings, walkLimitsFrom } from "../settings.mjs";
import { runGit } from "./git-core.mjs";

// A read-path memo of the layer's git history must not outlive the history —
// mcp-server is a session-lifetime process, so a boot-time snapshot would serve
// stale dates all session. Short enough to pick up local commits, long enough
// that a search sweep is one `git log`, not one per concept.
const HISTORY_TTL_MS = 30000;

// The most one document may weigh before a local layer stops reading it. There
// was no ceiling at all: a 500MB .md dropped into a vault was read whole into a
// JS string, on a read path the desktop app runs inside its own process. The
// github adapter has capped at 1MB since it was written; local layers were the
// gap. Shared with the file editor's MAX_EDITABLE_BYTES on purpose — a document
// too big to index is one the cascade will never read, so offering to edit it
// would misrepresent what saving it accomplishes.
export const MAX_DOC_BYTES = 2_000_000;

export function createOkfLocalSource({ name, level, root, limits = null }) {
  let history = null; // { at, promise } — see commitHistory
  let warned = false;

  function warnOnce(message) {
    if (warned) return;
    warned = true;
    console.error(`[okf-local source "${name}"] ${message}`); // stderr: stdout is the MCP protocol
  }

  // Memoize the PROMISE, never the map. Publishing a half-built map before the
  // await would let every concurrent reader find it empty, miss, and fall back
  // to the mtime — which is the precise wrong answer this whole path exists to
  // prevent, and mcp-server handles requests concurrently.
  function commitHistory() {
    if (!history || Date.now() - history.at >= HISTORY_TTL_MS) {
      history = { at: Date.now(), promise: readHistory() };
    }
    return history.promise;
  }

  // A section date has to say when the CONTENT last changed. An okf-local
  // bundle is a git repo, and git does not preserve mtimes — clone, checkout
  // and pull all stamp the working tree with the operation time — so an mtime
  // would report "today" for a decision written years ago, in the one field the
  // product sells as the staleness signal. Read the commit history instead.
  //
  // Batched per generation, not per file: mcp-server sweeps loadConcept over
  // every id for search/list, so a per-file spawn is not affordable.
  async function readHistory() {
    const dates = new Map();
    // --git-path resolves even when the git dir is not ".git" (worktrees, GIT_DIR).
    const where = await runGit(root, ["rev-parse", "--git-path", "shallow"], { allowFailure: true });
    if (!where.ok) {
      // A plain folder is a legitimate okf-local root, so "not a repository" is
      // not worth a word. Anything else — no git on PATH, a safe.directory
      // refusal — means dates silently degrade to mtimes, and that must be said
      // out loud or the layer just quietly starts claiming everything is new.
      if (!/not a git repository/i.test(where.stderr)) {
        warnOnce(`cannot read git history (${where.stderr}) — sections will fall back to file mtimes`);
      }
      return { dates, inRepo: false, tracked: null };
    }
    const boundary = readShallowBoundary(path.resolve(root, where.stdout));

    // %as is the AUTHOR date, not the committer date: git-core runs
    // `pull --rebase` as its standard divergence recovery, and a rebase rewrites
    // every committer date to now — which would re-date the whole bundle to
    // today on the very flow team-sync depends on. Author dates survive it.
    // --relative prints paths relative to this layer root, so a layer inside a
    // bigger repo needs no prefix arithmetic; `-- .` bounds the walk to it.
    // core.quotePath=false keeps non-ASCII paths literal so they match our keys.
    const log = await runGit(
      root,
      ["-c", "core.quotePath=false", "log", "--format=%x00%as%x00%H", "--name-only", "--relative", "--", "."],
      { allowFailure: true },
    );
    // Inside a repo, a failed history read means the dates are unknown — NOT
    // that the mtime is now trustworthy. Returning an empty tracked set here
    // would date every doc today, the exact lie this path exists to prevent.
    if (!log.ok) {
      warnOnce(`cannot read commit dates (${log.stderr}) — sections in this layer will be undated`);
      return { dates, inRepo: true, tracked: null };
    }
    // Newest-first, so the first date seen for a path is its latest.
    let date = null;
    for (const line of log.stdout.split("\n")) {
      if (line.startsWith("\0")) {
        const [, authored, hash] = line.split("\0");
        // A shallow clone's boundary commit lists the ENTIRE tree as added at
        // the truncation date. Trusting it would date every untouched file to
        // the clone — mtime's lie by another route. Leave those paths undated.
        date = boundary.has(hash) ? null : authored;
      } else if (line !== "" && date && !dates.has(line)) {
        dates.set(line, date);
      }
    }
    // ls-files prints cwd-relative paths, matching the log's --relative keys.
    // Needed to tell "untracked, so the mtime is the true edit time" apart from
    // "tracked but the history could not date it", where the mtime is a lie.
    const listed = await runGit(root, ["-c", "core.quotePath=false", "ls-files"], { allowFailure: true });
    if (!listed.ok) {
      warnOnce(`cannot list tracked files (${listed.stderr}) — undatable sections will be undated`);
    }
    return { dates, inRepo: true, tracked: listed.ok ? new Set(listed.stdout.split("\n").filter(Boolean)) : null };
  }

  async function documentDate(filePath) {
    const { dates, inRepo, tracked } = await commitHistory();
    const rel = toPosix(path.relative(root, filePath));
    const authored = dates.get(rel);
    if (authored) return authored;
    // Inside a repo with no date for this path, the mtime is a checkout time,
    // not an edit time. That covers a truncated history (shallow clone), a change
    // that only landed inside a merge commit, and a history we could not read at
    // all (tracked === null, so we cannot rule any of it out). None of them has
    // an honest date — say nothing rather than claim today.
    if (inRepo && (tracked === null || tracked.has(rel))) return null;
    // Untracked, or no repo at all: here the mtime IS the real edit time, the
    // same signal files.mjs uses for the plain folders it points at.
    try {
      // Async stat: this runs in the read path, and on the desktop app the
      // engine must never block its loop on the filesystem.
      return localDate((await fsp.stat(filePath)).mtime);
    } catch {
      return null; // vanished between read and stat — undated beats crashing the resolve
    }
  }

  return {
    name,
    level,
    async loadConcept(id) {
      const safeId = normalizeConceptId(id);
      const filePath = path.join(root, `${safeId}.md`);
      // Stat before read, not alongside it: the point of the cap is to never
      // allocate the file, so its size has to be known first. The walk applies
      // the same ceiling, so this only fires for a live single-concept read.
      const bytes = await fileSize(filePath);
      if (bytes === null) return null; // missing or unreadable — a miss, not a crash
      if (bytes > MAX_DOC_BYTES) return null;
      let content;
      try {
        content = await fsp.readFile(filePath, "utf8");
      } catch {
        return null;
      }
      return withDocumentDate(parseConcept(content), await documentDate(filePath));
    },
    async listConceptIds({ signal = null, notes = null } = {}) {
      const files = await walkDocs(root, [".md"], limits, { signal, notes });
      return files.map((filePath) =>
        toPosix(path.relative(root, filePath)).replace(/\.md$/i, ""),
      );
    },
    // withGitSync calls this after a pull that changed something — new commits
    // mean new dates, so the memo must not outlive them.
    sync() {
      history = null;
    },
    close() {},
  };
}

// ---- document dates --------------------------------------------------------

// The commits a shallow clone truncated at. Their diff is the whole tree, so
// their date describes the clone, not the content.
function readShallowBoundary(shallowFile) {
  try {
    return new Set(fs.readFileSync(shallowFile, "utf8").split("\n").filter(Boolean));
  } catch {
    return new Set(); // absent = a complete clone, the common case
  }
}

// Fills in section dates the document did not state. Explicit per-section attrs
// ({updated=}) stay authoritative; otherwise an OKF-level `updated` wins, then
// the adapter's document date (a commit date here and in github.mjs, an mtime
// for the plain folders files.mjs reads). Every adapter applies this — the same
// bytes must produce the same staleness metadata no matter which kind of layer
// read them. Kept out of parseConcept so callers that only want the literal
// document (promote.mjs, team-activity.mjs) are unaffected.
export function withDocumentDate(parsed, documentDate) {
  const fallback = parsed.frontmatter.updated ?? documentDate ?? null;
  return {
    ...parsed,
    sections: parsed.sections.map((section) => ({ ...section, updated: section.updated ?? fallback })),
  };
}

// A file's mtime is a local wall-clock event, so it has to be formatted in
// local time: toISOString() would file an edit made this evening under
// tomorrow's date. (API timestamps are real UTC instants — github.mjs formats
// those as UTC, correctly.)
export function localDate(when) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

// ---- OKF parsing (moved verbatim from resolver.mjs) ------------------------

export function parseConcept(content) {
  const { frontmatter, body } = parseFrontmatter(content);
  return { frontmatter, sections: parseSections(body) };
}

function parseSections(body) {
  const lines = body.split(/\r?\n/);
  const sections = [];
  let current = { key: "", heading: null, level: 0, lines: [], updated: null, override: null };
  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (match) {
      pushSection(sections, current);
      const attrs = parseHeadingAttrs(match[2]);
      const key = attrs.key ?? normalizeHeading(match[2]);
      current = { key, heading: line, level: match[1].length, lines: [], updated: attrs.updated, override: attrs.override };
    } else {
      current.lines.push(line);
    }
  }
  pushSection(sections, current);
  return sections;
}

// Shared with other adapters (files.mjs). `key` is null when the heading has
// no {#key} attr — callers pick their own fallback keying scheme.
export function parseHeadingAttrs(headingText) {
  const brace = headingText.match(/\{([^}]*)\}/);
  let key = null;
  let updated = null;
  let override = null;
  if (brace) {
    for (const token of brace[1].trim().split(/\s+/)) {
      if (token.startsWith("#")) key = token.slice(1).toLowerCase();
      else if (token.startsWith("updated=")) updated = token.slice(8).replace(/^['"]|['"]$/g, "");
      else if (token.startsWith("override=")) override = token.slice(9).replace(/^['"]|['"]$/g, "");
    }
  }
  return { key, updated, override };
}

function pushSection(sections, section) {
  const hasContent = section.lines.some((line) => line.trim() !== "");
  if (section.heading === null && !hasContent) return;
  sections.push(section);
}

// Shared with other adapters (files.mjs): section keys must derive identically
// across adapters or same-heading sections stop merging between layer kinds.
export function normalizeHeading(text) {
  return text.replace(/\{[^}]*\}/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}

function parseFrontmatter(content) {
  if (!content.startsWith("---\n")) return { frontmatter: {}, body: content };
  const end = content.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: content };
  const raw = content.slice(4, end).trim();
  const body = content.slice(end + 4).replace(/^\n/, "");
  const frontmatter = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    frontmatter[match[1]] = parseYamlScalar(match[2].trim());
  }
  return { frontmatter, body };
}

function parseYamlScalar(value) {
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1).split(",").map((p) => p.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  }
  return value.replace(/^['"]|['"]$/g, "");
}

export function normalizeConceptId(value) {
  const normalized = path.posix.normalize(String(value).replace(/\\/g, "/").replace(/\.md$/i, ""));
  if (isTraversal(normalized)) throw new Error(`Invalid concept ID: ${value}`);
  return normalized;
}

// A concept id must stay within its layer root — reject any path-traversal form:
// a bare ".." (no trailing slash), a trailing "/..", and absolute paths. The guard
// is self-contained (does not rely on the caller using path.join over path.resolve).
export function isTraversal(normalized) {
  return (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  );
}

// ---- shared bounded walk ----------------------------------------------------
//
// One async walker for every disk-backed adapter (okf-local, files, and the
// service's add-time folder probe). Async so a big tree never monopolizes its
// process's event loop. The desktop runs this work in an isolated utility
// process, keeping it off the Electron UI thread. Bounded so a folder that is
// too large to be a context layer (a home directory, a monorepo checkout)
// fails fast with an actionable message instead of grinding for minutes.
// Same skip posture as before: dot-entries and node_modules are skipped, and
// symlinks are never followed (Dirent.isDirectory/isFile are false for them).
//
// The caps are user-facing settings (settings.mjs): the manifest's `settings`
// block wins, the environment is the fallback, and callers that already know
// the effective settings pass `limits` explicitly.

export function defaultWalkLimits() {
  return walkLimitsFrom(resolveSettings({}));
}

// Both walks below are one long await from a caller's point of view, so a
// cancelled index would otherwise keep scanning to the end — and a layer that
// churns would accumulate one abandoned walk per cancelled job. Checked per
// directory rather than per entry: a readdir is the unit of work, and the
// signal's own reason carries why (superseded, timed out) to whoever awaits.
function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Walk cancelled");
}

/**
 * Cheap "does this folder hold any documents?" check for the add-source form.
 * Stops at the first hit and at a small scan ceiling, so it answers in
 * milliseconds on a normal folder and stays bounded on a huge one. Never
 * throws on size — being too big is an indexing outcome, not a form error.
 */
export async function probeDocs(root, extensions, maxEntries = 4_000, { signal = null } = {}) {
  let scanned = 0;
  const stack = [root];
  while (stack.length > 0) {
    throwIfAborted(signal);
    const current = stack.pop();
    let dirents;
    try { dirents = await fsp.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const dirent of dirents) {
      if (dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
      if (++scanned > maxEntries) return { found: false, scanned, complete: false };
      if (dirent.isDirectory()) stack.push(path.join(current, dirent.name));
      else if (dirent.isFile() && extensions.some((ext) => dirent.name.endsWith(ext))) {
        return { found: true, scanned, complete: true };
      }
    }
  }
  return { found: false, scanned, complete: true };
}

/**
 * Every indexable document under `root`, bounded by the walk limits.
 *
 * `notes` is an optional collector — { skipped: [], unreadable: [] } — that the
 * walk appends to. It is passed in rather than returned because the wrappers a
 * layer may be built with (withGitSync) forward their options argument but
 * return their own object, so a collector reaches the walk where an extra
 * return value or an adapter method would not. Both lists describe documents
 * the caller is NOT getting, and both used to be silent: an unreadable subtree
 * produced a source that reported "ok" with quietly missing content.
 */
export async function walkDocs(root, extensions, limits = null, { signal = null, notes = null } = {}) {
  if (!root) return [];
  const { maxFiles, maxEntries } = { ...defaultWalkLimits(), ...(limits ?? {}) };
  const files = [];
  let scanned = 0;
  let hiddenSkipped = 0;
  const stack = [root];
  while (stack.length > 0) {
    throwIfAborted(signal);
    const current = stack.pop();
    let dirents;
    try {
      dirents = await fsp.readdir(current, { withFileTypes: true });
    } catch (err) {
      // The layer ROOT failing to read is a different fact from an ordinary
      // subdirectory going missing mid-walk: the root is the whole source, so
      // losing it means there is nothing left behind this layer at all — not
      // the empty-folder answer a deleted vault used to get, indistinguishable
      // from one that was simply never populated.
      if (current === root && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
        throw new Error(`Layer folder no longer exists: ${root}`);
      }
      // Skipping is still right for everything else — one locked or vanished
      // subfolder must not fail the whole layer — but a folder we are not
      // ALLOWED to read is a different fact from a folder with nothing in it,
      // and only one of them is worth saying.
      if (err.code === "EACCES" || err.code === "EPERM") {
        notes?.unreadable.push({ rel: relTo(root, current), code: err.code });
      }
      continue;
    }
    const candidates = [];
    for (const dirent of dirents) {
      if (dirent.name.startsWith(".")) { hiddenSkipped += 1; continue; }
      if (dirent.name === "node_modules") continue;
      scanned += 1;
      if (scanned > maxEntries) {
        throw new Error(
          `This folder is too large to index (scanned over ${maxEntries.toLocaleString("en-US")} entries). ` +
            `Choose a more specific folder, such as your notes or docs directory.`,
        );
      }
      const fullPath = path.join(current, dirent.name);
      if (dirent.isDirectory()) stack.push(fullPath);
      else if (dirent.isFile() && extensions.some((ext) => dirent.name.endsWith(ext))) candidates.push(fullPath);
    }
    // One stat per candidate, batched per directory rather than awaited one at
    // a time, so the cap costs a round of parallel syscalls instead of a serial
    // chain across a large vault.
    const sizes = await Promise.all(candidates.map(fileSize));
    for (let i = 0; i < candidates.length; i += 1) {
      if (sizes[i] !== null && sizes[i] > MAX_DOC_BYTES) {
        notes?.skipped.push({ rel: relTo(root, candidates[i]), bytes: sizes[i] });
        continue;
      }
      files.push(candidates[i]);
      if (files.length > maxFiles) {
        throw new Error(
          `This folder has too many documents to index (over ${maxFiles.toLocaleString("en-US")}). ` +
            `Choose a more specific folder, such as your notes or docs directory.`,
        );
      }
    }
  }
  // A skip an entry never mentions is a skip nobody can act on. Counted, not
  // itemized — one number per source is enough to say "this is deliberate",
  // and the walk never descends into a dot-dir to name what is inside it.
  if (notes) notes.hidden = (notes.hidden ?? 0) + hiddenSkipped;
  return files.sort();
}

async function fileSize(filePath) {
  try {
    return (await fsp.stat(filePath)).size;
  } catch {
    return null; // vanished or unreadable between readdir and stat — let the read path decide
  }
}

function relTo(root, target) {
  return toPosix(path.relative(root, target)) || ".";
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
