// OKF-local source adapter: reads an OKF bundle (git repo of markdown + YAML
// frontmatter) from disk. Owns all OKF parsing. Implements the source contract:
//   loadConcept(id) -> { frontmatter, sections } | null
//   listConceptIds() -> string[]
//   sync() -> drops the commit-date memo      close() -> noop

import fs from "node:fs";
import path from "node:path";
import { runGit } from "./git-core.mjs";

// A read-path memo of the layer's git history must not outlive the history —
// mcp-server is a session-lifetime process, so a boot-time snapshot would serve
// stale dates all session. Short enough to pick up local commits, long enough
// that a search sweep is one `git log`, not one per concept.
const HISTORY_TTL_MS = 30000;

export function createOkfLocalSource({ name, level, root }) {
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
      return { dates, tracked: null };
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
    if (!log.ok) {
      warnOnce(`cannot read commit dates (${log.stderr}) — sections will fall back to file mtimes`);
      return { dates, tracked: null };
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
    return { dates, tracked: listed.ok ? new Set(listed.stdout.split("\n").filter(Boolean)) : null };
  }

  async function documentDate(filePath) {
    const { dates, tracked } = await commitHistory();
    const rel = toPosix(path.relative(root, filePath));
    const authored = dates.get(rel);
    if (authored) return authored;
    // Tracked but undated: history was truncated (shallow clone) or the change
    // only ever landed inside a merge commit. The mtime is a checkout time here,
    // so there is no honest date to give — say nothing rather than claim today.
    if (tracked?.has(rel)) return null;
    // Untracked, or no history at all: the mtime IS the real edit time, the same
    // signal files.mjs uses for the plain folders it points at.
    return localDate(fs.statSync(filePath).mtime);
  }

  return {
    name,
    level,
    async loadConcept(id) {
      const safeId = normalizeConceptId(id);
      const filePath = path.join(root, `${safeId}.md`);
      if (!fs.existsSync(filePath)) return null;
      const parsed = parseConcept(fs.readFileSync(filePath, "utf8"));
      return withDocumentDate(parsed, await documentDate(filePath));
    },
    async listConceptIds() {
      return walkMarkdown(root).map((filePath) =>
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

function walkMarkdown(root) {
  if (!root || !fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
      if (dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
      const fullPath = path.join(current, dirent.name);
      if (dirent.isDirectory()) stack.push(fullPath);
      else if (dirent.isFile() && dirent.name.endsWith(".md")) files.push(fullPath);
    }
  }
  return files.sort();
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
