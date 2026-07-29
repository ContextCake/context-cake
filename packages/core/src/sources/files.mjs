// Files source adapter: points at ANY plain directory of docs (.md/.mdx/.txt)
// and turns it into a context layer — no OKF authoring required. Markdown with
// YAML frontmatter gets full OKF parsing (delegated to okf-local); everything
// else gets synthesized frontmatter and sections. Implements the source contract:
//   loadConcept(id) -> { frontmatter, sections } | null
//   listConceptIds() -> string[]
//   close() -> noop

import fs from "node:fs";
import path from "node:path";
import { parseConcept, parseHeadingAttrs, normalizeConceptId, normalizeHeading, withDocumentDate } from "./okf-local.mjs";

// loadConcept resolution order on id collision (e.g. notes.md + notes.txt).
const EXTENSIONS = [".md", ".mdx", ".txt"];

// Shared with remote adapters that ingest the same plain-document shapes
// (github.mjs) — the extension set and the parsing below must stay one
// implementation or section keys drift and the cascade stops merging. Order is
// meaningful: it is the tie-break when one concept id has several extensions.
// Frozen because it is the same array the local adapter walks.
export const DOC_EXTENSIONS = Object.freeze([...EXTENSIONS]);

export function createFilesSource({ name, level, root }) {
  return {
    name,
    level,
    async loadConcept(id) {
      let safeId;
      try {
        safeId = normalizeConceptId(id); // throws on traversal (isTraversal guard)
      } catch {
        return null; // an arbitrary folder is user-facing — a bad id is a miss, not a crash
      }
      for (const ext of EXTENSIONS) {
        const filePath = path.join(root, `${safeId}${ext}`);
        if (fs.existsSync(filePath)) return parseFile(filePath, ext);
      }
      return null;
    },
    async listConceptIds() {
      const ids = walkFiles(root).map((filePath) =>
        toPosix(path.relative(root, filePath)).replace(/\.(md|mdx|txt)$/, ""),
      );
      return [...new Set(ids)];
    },
    close() {},
  };
}

function parseFile(filePath, ext) {
  const content = fs.readFileSync(filePath, "utf8");
  const mtime = fs.statSync(filePath).mtime.toISOString().slice(0, 10);
  return parseDocument({ content, stem: path.basename(filePath, ext), updated: mtime, ext });
}

// The document-shape rules, independent of where the bytes came from. Remote
// adapters call this with their own `updated` (a commit date rather than an
// mtime) so a GitHub-hosted CLAUDE.md and a local one resolve identically.
export function parseDocument({ content, stem, updated, ext = ".md" }) {
  if (ext === ".txt") return parsePlainText(content, stem, updated);
  // Undated sections inherit the OKF-level date, then this adapter's document
  // date — same rule okf-local applies, so structured docs never lose the
  // per-document staleness metadata that plain documents receive.
  if (hasFrontmatter(content)) return withDocumentDate(parseConcept(content), updated);
  return parsePlainMarkdown(content, stem, updated);
}

// Mirrors okf-local's parseFrontmatter detection: opening --- fence with a closer.
function hasFrontmatter(content) {
  return content.startsWith("---\n") && content.indexOf("\n---", 4) !== -1;
}

// Plain markdown (no frontmatter): first H1 becomes the title (not a section),
// `##` headings delimit sections (deeper headings stay inside their section),
// anything before the first `##` is "overview". OKF heading attrs still win
// when present ({#key updated= override=}); otherwise key = normalizeHeading
// (okf-local's scheme — adapters must derive keys identically or sections stop
// merging across layer kinds) and updated = mtime.
function parsePlainMarkdown(content, stem, mtime) {
  let title = null;
  const sections = [];
  let current = { key: "overview", heading: null, level: 0, lines: [], updated: mtime, override: null };
  for (const line of content.split(/\r?\n/)) {
    const h1 = line.match(/^#\s+(.+?)\s*$/);
    if (h1 && title === null) {
      title = stripAttrs(h1[1]);
      continue;
    }
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      pushPlainSection(sections, current);
      const attrs = parseHeadingAttrs(h2[1]);
      current = {
        key: attrs.key ?? normalizeHeading(h2[1]),
        heading: line,
        level: 2,
        lines: [],
        updated: attrs.updated ?? mtime,
        override: attrs.override,
      };
    } else {
      current.lines.push(line);
    }
  }
  pushPlainSection(sections, current);
  if (sections.length === 1 && sections[0].heading === null) sections[0].key = "body";
  return { frontmatter: { type: "document", title: title ?? stem }, sections };
}

function parsePlainText(content, stem, mtime) {
  const sections = [];
  pushPlainSection(sections, { key: "body", heading: null, level: 0, lines: content.split(/\r?\n/), updated: mtime, override: null });
  return { frontmatter: { type: "document", title: stem }, sections };
}

// Same posture as okf-local's pushSection: drop a heading-less section with no content.
function pushPlainSection(sections, section) {
  const hasContent = section.lines.some((line) => line.trim() !== "");
  if (section.heading === null && !hasContent) return;
  sections.push(section);
}

function stripAttrs(text) {
  return text.replace(/\{[^}]*\}/g, "").trim();
}

// Same walk posture as okf-local: skip dot-entries and node_modules; symlinks
// are skipped entirely (Dirent.isDirectory/isFile are false for symlinks), so a
// link escaping root is never followed.
function walkFiles(root) {
  if (!root || !fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
      if (dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
      const fullPath = path.join(current, dirent.name);
      if (dirent.isDirectory()) stack.push(fullPath);
      else if (dirent.isFile() && EXTENSIONS.some((ext) => dirent.name.endsWith(ext))) files.push(fullPath);
    }
  }
  return files.sort();
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
