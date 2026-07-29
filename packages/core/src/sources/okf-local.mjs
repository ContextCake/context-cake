// OKF-local source adapter: reads an OKF bundle (git repo of markdown + YAML
// frontmatter) from disk. Owns all OKF parsing. Implements the source contract:
//   loadConcept(id) -> { frontmatter, sections } | null
//   listConceptIds() -> string[]
//   sync() -> drops the commit-date memo      close() -> noop

import fs from "node:fs";
import path from "node:path";
import { runGit } from "./git-core.mjs";

export function createOkfLocalSource({ name, level, root }) {
  let commitDates = null; // Map<posix relpath, "YYYY-MM-DD">; null until first read

  // A section date has to say when the CONTENT last changed. An okf-local
  // bundle is a git repo, and git does not preserve mtimes — clone, checkout
  // and pull all stamp the working tree with the operation time — so an mtime
  // would report "today" for a decision written years ago, in the one field the
  // product sells as the staleness signal. Read the last-commit date per path
  // instead, which is what github.mjs reports for the same bytes.
  //
  // One batched `git log` per generation, not one per file: mcp-server sweeps
  // loadConcept over every id for search/list, so a per-file spawn is not
  // affordable. Output is newest-first, so the first date seen for a path wins.
  async function loadCommitDates() {
    if (commitDates) return commitDates;
    commitDates = new Map();
    // A layer root is often a subdirectory of a bigger repo. git reports paths
    // from the REPO root, so without this prefix every lookup would miss and
    // silently fall back to the mtime — the exact failure this replaces.
    const prefix = await runGit(root, ["rev-parse", "--show-prefix"], { allowFailure: true });
    if (!prefix.ok) return commitDates; // not a git repo (or no git) — mtime is the only signal
    // core.quotePath=false keeps non-ASCII paths literal so they match the
    // relative paths we look them up by. %x00 marks the date lines apart from
    // the --name-only paths that follow them. `-- .` bounds the walk to this
    // layer, so a layer inside a monorepo does not pay for the whole history.
    const log = await runGit(
      root,
      ["-c", "core.quotePath=false", "log", "--format=%x00%cs", "--name-only", "--", "."],
      { allowFailure: true },
    );
    if (!log.ok) return commitDates;
    let date = null;
    for (const line of log.stdout.split("\n")) {
      if (line.startsWith("\0")) date = line.slice(1);
      else if (line !== "" && date) {
        const rel = line.startsWith(prefix.stdout) ? line.slice(prefix.stdout.length) : line;
        if (!commitDates.has(rel)) commitDates.set(rel, date);
      }
    }
    return commitDates;
  }

  // Untracked files have no commit date, and there the mtime IS the real edit
  // time — same signal files.mjs uses for the plain folders it points at.
  async function documentDate(filePath) {
    const tracked = (await loadCommitDates()).get(toPosix(path.relative(root, filePath)));
    return tracked ?? localDate(fs.statSync(filePath).mtime);
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
      commitDates = null;
    },
    close() {},
  };
}

// ---- document dates --------------------------------------------------------

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
