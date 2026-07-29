// OKF-local source adapter: reads an OKF bundle (git repo of markdown + YAML
// frontmatter) from disk. Owns all OKF parsing. Implements the source contract:
//   loadConcept(id) -> { frontmatter, sections } | null
//   listConceptIds() -> string[]
//   close() -> noop

import fsp from "node:fs/promises";
import path from "node:path";
import { resolveSettings, walkLimitsFrom } from "../settings.mjs";

export function createOkfLocalSource({ name, level, root, limits = null }) {
  return {
    name,
    level,
    async loadConcept(id) {
      const safeId = normalizeConceptId(id);
      const filePath = path.join(root, `${safeId}.md`);
      let content;
      try {
        content = await fsp.readFile(filePath, "utf8");
      } catch {
        return null;
      }
      return parseConcept(content);
    },
    async listConceptIds() {
      const files = await walkDocs(root, [".md"], limits);
      return files.map((filePath) =>
        toPosix(path.relative(root, filePath)).replace(/\.md$/i, ""),
      );
    },
    close() {},
  };
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

/**
 * Cheap "does this folder hold any documents?" check for the add-source form.
 * Stops at the first hit and at a small scan ceiling, so it answers in
 * milliseconds on a normal folder and stays bounded on a huge one. Never
 * throws on size — being too big is an indexing outcome, not a form error.
 */
export async function probeDocs(root, extensions, maxEntries = 4_000) {
  let scanned = 0;
  const stack = [root];
  while (stack.length > 0) {
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

export async function walkDocs(root, extensions, limits = null) {
  if (!root) return [];
  const { maxFiles, maxEntries } = { ...defaultWalkLimits(), ...(limits ?? {}) };
  const files = [];
  let scanned = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let dirents;
    try {
      dirents = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue; // missing root or an unreadable subfolder — skip, don't crash the layer
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
      scanned += 1;
      if (scanned > maxEntries) {
        throw new Error(
          `This folder is too large to index (scanned over ${maxEntries.toLocaleString("en-US")} entries). ` +
            `Choose a more specific folder, such as your notes or docs directory.`,
        );
      }
      const fullPath = path.join(current, dirent.name);
      if (dirent.isDirectory()) stack.push(fullPath);
      else if (dirent.isFile() && extensions.some((ext) => dirent.name.endsWith(ext))) {
        files.push(fullPath);
        if (files.length > maxFiles) {
          throw new Error(
            `This folder has too many documents to index (over ${maxFiles.toLocaleString("en-US")}). ` +
              `Choose a more specific folder, such as your notes or docs directory.`,
          );
        }
      }
    }
  }
  return files.sort();
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
