// GitHub source adapter: turns the markdown a team already keeps in a repo
// (CLAUDE.md, AGENTS.md, README.md, docs/**, .context/**) into a context layer
// — no clone, no OKF authoring. Read-only: one recursive git-tree call builds
// the id index, then raw content plus the file's last commit date per concept.
// Document parsing is delegated to files.mjs so a repo-hosted doc and a local
// one produce identical section keys and merge in the cascade.
//
// Resilience (integrations spec §5): an unreachable, rate-limited, or
// unauthorized GitHub degrades to a warning and an empty result. It is never a
// hard failure — the remaining layers still resolve.
//
// Credentials arrive by value from the caller (sources/index.mjs). This module
// never reads a keychain, an environment variable, or a manifest.
//
// Implements the source contract:
//   loadConcept(id) -> { frontmatter, sections } | null
//   listConceptIds() -> string[]         ids are "<owner>/<repo>/<path minus ext>"
//   sync() -> invalidates the index      close() -> noop

import path from "node:path";
import { isTraversal } from "./okf-local.mjs";
import { parseDocument, DOC_EXTENSIONS } from "./files.mjs";

// What a repo is assumed to hold unless the layer says otherwise.
const DEFAULT_PATHS = ["CLAUDE.md", "AGENTS.md", "README.md", "docs/**", ".context/**"];
const DEFAULT_API_BASE = "https://api.github.com";
const MAX_FILE_BYTES = 1_000_000; // a context doc that big is a data file, not context
const INDEX_TTL_MS = 300_000;
const REQUEST_TIMEOUT_MS = 10_000;
// After a failure, stop retrying (and stop warning) for this long. A search
// sweeps every concept in every layer, so without a cooldown one unreachable
// repo means one API call and one stderr line per concept — the worst possible
// behavior when the thing that failed was a rate limit.
const FAILURE_COOLDOWN_MS = 60_000;

export function createGithubSource({
  name,
  level,
  repo,
  ref = null,
  paths = DEFAULT_PATHS,
  apiBase = DEFAULT_API_BASE,
  token = null,
  maxFileBytes = MAX_FILE_BYTES,
  indexTtlMs = INDEX_TTL_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  failureCooldownMs = FAILURE_COOLDOWN_MS,
  now = Date.now,
}) {
  const slug = assertRepoSlug(repo, name);
  const matchers = (paths.length ? paths : DEFAULT_PATHS).map(globToRegExp);
  const base = String(apiBase).replace(/\/+$/, "");

  // The last index that loaded successfully. Deliberately kept past its TTL: if
  // a refresh fails, stale-but-labelled beats an empty layer (integrations spec
  // §5 — serve from cache and surface the age, never hard-fail).
  let index = null; // { entries: Map<conceptId, {path, ext}>, branch, pushedAt, at }
  let failure = null; // { at, error } — most recent refresh failure
  let warnedAt = 0;
  const commitDates = new Map(); // repo path -> YYYY-MM-DD (cleared with the index)

  // The token never reaches a log line, and a credential embedded in a custom
  // apiBase (https://user:pass@host) never survives an error message either.
  function scrub(message) {
    return String(message)
      .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]")
      .replace(/\/\/[^/@\s]+@/g, "//[redacted]@");
  }

  // One line per cooldown window, not one per concept in a sweep.
  function warnOnce(message) {
    if (warnedAt && now() - warnedAt < failureCooldownMs) return;
    warnedAt = now();
    console.error(`[github source "${name}"] ${slug} ${message}`);
  }

  function warn(e) {
    warnOnce(`unavailable: ${scrub(e.message)} — resolving without it`);
  }

  async function api(pathname, { raw = false, search = null } = {}) {
    const url = new URL(base + pathname);
    if (search) for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value);
    const headers = {
      Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "contextcake",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    // Errors quote only the pathname, never the built URL — apiBase is caller
    // configuration and may carry userinfo.
    const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(requestTimeoutMs) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub API ${res.status} on ${pathname}`);
    if (!raw) return res.json();
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxFileBytes) {
      throw new Error(`${pathname} is ${declared} bytes (limit ${maxFileBytes})`);
    }
    const text = await res.text();
    if (text.length > maxFileBytes) throw new Error(`${pathname} exceeds ${maxFileBytes} bytes`);
    return text;
  }

  // One recursive tree call yields every candidate path, so loadConcept never
  // has to guess an extension. Memoized with its own TTL: without it a search
  // sweep (list + load every concept) would re-fetch the tree per concept.
  //
  // On a failed refresh the previous index is served rather than dropped, and
  // retries pause for the cooldown — a rate-limited repo must not be hit once
  // per concept, and a one-second blip must not blank a layer.
  async function loadIndex() {
    if (index && now() - index.at < indexTtlMs) return index;
    if (failure && now() - failure.at < failureCooldownMs) {
      if (index) return index;
      throw failure.error;
    }
    try {
      index = await fetchIndex();
      failure = null;
      warnedAt = 0;
      return index;
    } catch (e) {
      failure = { at: now(), error: e };
      if (!index) throw e;
      warnOnce(`unreachable: ${scrub(e.message)} — serving the index cached ${ageLabel(now() - index.at)} ago`);
      return index;
    }
  }

  async function fetchIndex() {
    const meta = await api(`/repos/${slug}`);
    if (!meta) throw new Error(`repository ${slug} not found (or not visible to this token)`);
    const branch = ref ?? meta.default_branch ?? "HEAD";
    const tree = await api(`/repos/${slug}/git/trees/${encodeURIComponent(branch)}`, { search: { recursive: "1" } });
    if (!tree) throw new Error(`ref "${branch}" not found in ${slug}`);
    if (tree.truncated) {
      console.error(`[github source "${name}"] ${slug} tree listing was truncated by the API — narrow "paths" to index the whole layer`);
    }
    const entries = new Map();
    for (const node of tree.tree ?? []) {
      if (node.type !== "blob") continue;
      const ext = DOC_EXTENSIONS.find((candidate) => node.path.endsWith(candidate));
      if (!ext) continue;
      if (Number(node.size) > maxFileBytes) continue;
      if (!matchers.some((re) => re.test(node.path))) continue;
      entries.set(`${slug}/${node.path.slice(0, -ext.length)}`, { path: node.path, ext });
    }
    return { entries, branch, pushedAt: dateOnly(meta.pushed_at), at: now() };
  }

  // The section date users actually care about is when the doc last changed,
  // not when the repo was last pushed — but a rate-limited or forbidden commits
  // call must not lose the concept, so pushed_at is the fallback.
  async function commitDate(repoPath, branch, pushedAt) {
    if (commitDates.has(repoPath)) return commitDates.get(repoPath);
    let date = pushedAt;
    try {
      const commits = await api(`/repos/${slug}/commits`, {
        search: { path: repoPath, sha: branch, per_page: "1" },
      });
      date = dateOnly(commits?.[0]?.commit?.committer?.date ?? commits?.[0]?.commit?.author?.date) ?? pushedAt;
    } catch {
      // keep pushedAt — a missing history date is not worth dropping the doc over
    }
    commitDates.set(repoPath, date);
    return date;
  }

  const source = {
    name,
    level,
    async loadConcept(id) {
      const repoPath = withinRepo(id, slug);
      if (!repoPath) return null;
      try {
        const { entries, branch, pushedAt } = await loadIndex();
        const entry = entries.get(`${slug}/${repoPath}`);
        if (!entry) return null;
        const content = await api(`/repos/${slug}/contents/${encodePath(entry.path)}`, {
          raw: true,
          search: { ref: branch },
        });
        if (content == null) return null;
        const updated = await commitDate(entry.path, branch, pushedAt);
        return parseDocument({
          content,
          stem: path.posix.basename(entry.path, entry.ext),
          updated,
          ext: entry.ext,
        });
      } catch (e) {
        warn(e);
        return null;
      }
    },
    async listConceptIds() {
      try {
        return [...(await loadIndex()).entries.keys()].sort();
      } catch (e) {
        warn(e);
        return [];
      }
    },
    lastSynced: null,
    // Explicit refresh: drop the index, the commit-date memo, and any failure
    // cooldown so the next read re-fetches immediately. The cache wrapper calls
    // through to this on its own sync().
    sync() {
      index = null;
      failure = null;
      warnedAt = 0;
      commitDates.clear();
      source.lastSynced = new Date(now()).toISOString();
      return source.lastSynced;
    },
    close() {},
  };
  return source;
}

// ---- helpers ---------------------------------------------------------------

// A bad slug is manifest misconfiguration, not a runtime degradation — fail at
// construction rather than warning on every read. The guard also keeps the slug
// from carrying path or query syntax into every request URL built from it.
function assertRepoSlug(repo, name) {
  const slug = String(repo ?? "").trim();
  const parts = slug.split("/");
  const valid =
    parts.length === 2 &&
    parts.every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..");
  if (!valid) {
    throw new Error(`Layer "${name}": "repo" must be "<owner>/<name>" (got ${JSON.stringify(repo)})`);
  }
  return slug;
}

// Concept ids are repo-qualified, so a layer answers only for its own repo and
// a traversal id can never climb out of it.
function withinRepo(id, slug) {
  const value = String(id ?? "");
  if (!value.startsWith(`${slug}/`)) return null;
  const rest = path.posix.normalize(value.slice(slug.length + 1));
  if (!rest || isTraversal(rest)) return null;
  return rest;
}

function encodePath(repoPath) {
  return repoPath.split("/").map(encodeURIComponent).join("/");
}

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : null;
}

// Cache age for the degradation warning — the point is "how stale is what you
// are reading", so minutes are plenty of resolution.
function ageLabel(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

// Minimal glob: "**" spans whole segments, "*" and "?" stay inside one. Covers
// the selector forms the spec defines (docs/**, CLAUDE.md, **/*.md) without a
// dependency; anything richer is a spec change, not a silent extension.
function globToRegExp(glob) {
  let out = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i += 2;
      if (glob[i] === "/") i += 1;
      out += "(?:.*/)?";
      if (i >= glob.length) out += ".*"; // a trailing "**" also matches the leaf
      continue;
    }
    if (c === "*") { out += "[^/]*"; i += 1; continue; }
    if (c === "?") { out += "[^/]"; i += 1; continue; }
    out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`${out}$`);
}
