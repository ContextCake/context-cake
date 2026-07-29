// Files source adapter: points at ANY plain directory of docs (.md/.mdx/.txt)
// and turns it into a context layer — no OKF authoring required. Markdown with
// YAML frontmatter gets full OKF parsing (delegated to okf-local); everything
// else gets synthesized frontmatter and sections. Implements the source contract:
//   loadConcept(id) -> { frontmatter, sections } | null
//   listConceptIds() -> string[]
//   close() -> noop

import fsp from "node:fs/promises";
import path from "node:path";
import { parseConcept, parseHeadingAttrs, normalizeConceptId, normalizeHeading, walkDocs } from "./okf-local.mjs";

// loadConcept resolution order on id collision (e.g. notes.md + notes.txt).
export const FILES_EXTENSIONS = [".md", ".mdx", ".txt"];

export function createFilesSource({ name, level, root, limits = null }) {
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
      for (const ext of FILES_EXTENSIONS) {
        const filePath = path.join(root, `${safeId}${ext}`);
        let content, stat;
        try {
          [content, stat] = await Promise.all([fsp.readFile(filePath, "utf8"), fsp.stat(filePath)]);
        } catch {
          continue; // missing under this extension — try the next one
        }
        return parseFile(content, stat.mtime.toISOString().slice(0, 10), path.basename(filePath, ext), ext);
      }
      return null;
    },
    async listConceptIds() {
      const files = await walkDocs(root, FILES_EXTENSIONS, limits);
      const ids = files.map((filePath) =>
        toPosix(path.relative(root, filePath)).replace(/\.(md|mdx|txt)$/, ""),
      );
      return [...new Set(ids)];
    },
    close() {},
  };
}

function parseFile(content, mtime, stem, ext) {
  if (ext === ".txt") return parsePlainText(content, stem, mtime);
  if (hasFrontmatter(content)) return parseConcept(content); // full OKF behavior, untouched
  return parsePlainMarkdown(content, stem, mtime);
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

function toPosix(value) {
  return value.split(path.sep).join("/");
}
