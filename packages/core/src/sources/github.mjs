// GitHub source adapter: turns the markdown a team already keeps in a repo
// (CLAUDE.md, AGENTS.md, README.md, docs/**, .context/**) into a context layer
// — no clone, no OKF authoring. Read-only: git-tree calls scoped to the
// configured selectors build the id index, then raw content plus the file's
// last commit date per concept. Document parsing is delegated to files.mjs so
// a repo-hosted doc and a local one produce identical section keys and merge
// in the cascade.
//
// Resilience (integrations spec §5): an unreachable, rate-limited, or
// unauthorized GitHub degrades to a warning and an empty result. It is never a
// hard failure — the remaining layers still resolve. Because that degradation
// is indistinguishable from an empty repo at the read API, health() reports the
// last swallowed failure out of band for callers that need to tell them apart.
//
// Credentials arrive by value from the caller (sources/index.mjs). This module
// never reads a keychain, an environment variable, or a manifest.
//
// Implements the source contract:
//   loadConcept(id) -> { frontmatter, sections } | null
//   listConceptIds() -> string[]         ids are "<owner>/<repo>/<path minus ext>"
//   sync() -> invalidates the index      close() -> noop
//   health() -> { ok, lastError, ... }   diagnostics only; never gates a read

import path from "node:path";
import { isTraversal } from "./okf-local.mjs";
import { parseDocument, DOC_EXTENSIONS } from "./files.mjs";

// What a repo is assumed to hold unless the layer says otherwise.
const DEFAULT_PATHS = ["CLAUDE.md", "AGENTS.md", "README.md", "docs/**", ".context/**"];
export const DEFAULT_API_BASE = "https://api.github.com";
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
  const selectors = paths.length ? paths : DEFAULT_PATHS;
  const matchers = selectors.map(globToRegExp);
  // The selectors decide which trees are even requested, not just which entries
  // survive — see treeScopes.
  const scopes = treeScopes(selectors);
  const base = String(apiBase).replace(/\/+$/, "");

  // The last index that loaded successfully. Deliberately kept past its TTL: if
  // a refresh fails, stale-but-labelled beats an empty layer (integrations spec
  // §5 — serve from cache and surface the age, never hard-fail).
  // Commit dates live INSIDE the index rather than beside it: a date belongs to
  // the generation of the tree it was read against, so a refreshed index must
  // start with an empty date memo or an upstream edit would keep reporting its
  // old date for the life of the process.
  let index = null; // { entries: Map<conceptId,{path,ext}>, dates: Map, branch, pushedAt, at }
  let failure = null; // { at, error } — most recent refresh failure, drives the retry cooldown
  let warnedAt = 0;
  // Everything above is about staying up; this one is about being honest. Reads
  // swallow API failures, so "no concepts" covers both an empty repo and an
  // unreachable one. lastError is the swallowed failure, kept until a
  // subsequent success in the SAME scope (an index refresh clears an "index"
  // failure, a content read clears a "content" one — they answer different
  // questions, so one succeeding says nothing about the other) or an explicit
  // sync(), and reported by health().
  let lastError = null; // { at, scope: "index" | "content", message } — message is scrubbed

  // The token never reaches a log line, and a credential embedded in a custom
  // apiBase (https://user:pass@host) never survives an error message either.
  // lastError now reaches an HTTP response body (health(), Sync's 502) rather
  // than only stderr, so the fine-grained PAT form is covered here too, not
  // just the classic gh[pousr]_ prefix.
  function scrub(message) {
    return String(message)
      .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]")
      .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted]")
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

  // Scrubbed at the point of record: health() is handed to an HTTP client, and
  // an error string must not become the one place a token escapes.
  function recordFailure(e, scope) {
    lastError = { at: now(), scope, message: scrub(e.message) };
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
    //
    // "manual", not "follow", precisely because the request is credentialed:
    // following a redirect would re-send the Authorization header to whatever
    // host the 3xx names, and whether it gets stripped cross-origin depends on
    // the fetch implementation. The token is bound to one host upstream
    // (sources/index.mjs); honoring a redirect would hand that decision back to
    // the server. A redirect is reported as the failure it is.
    const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(requestTimeoutMs) });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`GitHub API ${res.status} redirect on ${pathname} — not followed on a credentialed request`);
    }
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

  // Tree calls yield every candidate path, so loadConcept never has to guess an
  // extension. Memoized with its own TTL: without it a search sweep (list +
  // load every concept) would re-fetch the trees per concept.
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
      lastError = null;
      return index;
    } catch (e) {
      failure = { at: now(), error: e };
      recordFailure(e, "index");
      if (!index) throw e;
      warnOnce(`unreachable: ${scrub(e.message)} — serving the index cached ${ageLabel(now() - index.at)} ago`);
      return index;
    }
  }

  // One tree call per scope, in parallel — a scope is a directory the selectors
  // actually reach into (treeScopes). A scope GitHub doesn't have is a miss,
  // not a failure: selectors are written for a family of repos ("docs/**" for
  // every repo in the org), and the ones without a docs/ still index the rest.
  // That holds even when a layer has only ONE selector and that directory
  // doesn't exist yet — an ordinary state for a narrow selector on a repo
  // that hasn't created it, exactly the config this feature exists to enable
  // for an oversized repo. What IS still an error is a genuinely bad ref, and
  // "every scope missed" can't tell those two apart on its own — a probe of
  // the ref's root settles it with one extra request, only in that otherwise-
  // ambiguous case.
  async function fetchIndex() {
    const meta = await api(`/repos/${slug}`);
    if (!meta) throw new Error(`repository ${slug} not found (or not visible to this token)`);
    const branch = ref ?? meta.default_branch ?? "HEAD";
    if (scopes.length === 0) {
      // Every selector was rejected outright (e.g. all traversal attempts) —
      // nothing was even requested, so unlike the "all scopes missed" case
      // below there is no "maybe the directory just doesn't exist yet" story
      // to rule out. Always an error, no probe needed.
      throw new Error(`ref "${branch}" not found in ${slug}, or it holds none of the selected paths`);
    }
    const trees = await Promise.all(scopes.map((scope) => fetchScope(branch, scope)));
    if (trees.every((tree) => tree === null)) {
      // A scope with prefix "" already IS a root probe — if one was among the
      // scopes, its own fetch already came back null (every entry here did,
      // to reach this branch), which already answers "the ref doesn't exist".
      // Otherwise nothing here checked the root at all, so ask once, directly.
      const refExists = scopes.some((s) => s.prefix === "")
        ? false
        : (await api(`/repos/${slug}/git/trees/${encodeURIComponent(branch)}`)) !== null;
      if (!refExists) throw new Error(`ref "${branch}" not found in ${slug}`);
      // else: the ref is real, the configured directories just don't exist
      // yet — an empty layer, not a failure. entries below stays empty.
    }

    const entries = new Map();
    scopes.forEach((scope, i) => {
      // Subtree responses are relative to the subtree, so paths come back
      // "runbook.md" where the repo (and every concept id) says "docs/runbook.md".
      const prefix = scope.prefix ? `${scope.prefix}/` : "";
      for (const node of trees[i]?.tree ?? []) {
        if (node.type !== "blob") continue;
        const repoPath = prefix + node.path;
        const ext = DOC_EXTENSIONS.find((candidate) => repoPath.endsWith(candidate));
        if (!ext || repoPath === ext) continue; // ".md" is an extension, not a document
        if (Number(node.size) > maxFileBytes) continue;
        if (!matchers.some((re) => re.test(repoPath))) continue;
        const id = `${slug}/${repoPath.slice(0, -ext.length)}`;
        // a.md and a.txt collapse to the same id. Break the tie by DOC_EXTENSIONS
        // order, exactly as files.mjs does — otherwise the winner depends on the
        // order GitHub happened to return the tree in, and the same collision
        // resolves differently on disk and on GitHub.
        const held = entries.get(id);
        if (held && DOC_EXTENSIONS.indexOf(held.ext) <= DOC_EXTENSIONS.indexOf(ext)) continue;
        entries.set(id, { path: repoPath, ext });
      }
    });
    return { entries, dates: new Map(), branch, pushedAt: dateOnly(meta.pushed_at), at: now() };
  }

  async function fetchScope(branch, scope) {
    // "{ref}:{dir}" is GitHub's syntax for the tree object at a path — the
    // whole point of scoping, since it is the request itself that shrinks.
    const treeRef = scope.prefix
      ? `${encodeURIComponent(branch)}:${encodePath(scope.prefix)}`
      : encodeURIComponent(branch);
    const tree = await api(
      `/repos/${slug}/git/trees/${treeRef}`,
      scope.recursive ? { search: { recursive: "1" } } : {},
    );
    if (!tree) return null; // this repo doesn't have that directory
    if (tree.truncated) {
      // Publishing a partial index as complete would silently hide context, so
      // this stays a refusal even now that scoping exists: loadIndex retains
      // the last complete generation, or the source degrades to an empty
      // result when none exists yet. Naming the scope is what makes it
      // actionable — the fix is a narrower selector for THAT directory.
      const where = scope.prefix ? `${slug}:${scope.prefix}` : slug;
      throw new Error(`GitHub API returned a truncated tree for ${where}; refusing to index incomplete context`);
    }
    return tree;
  }

  // The section date users actually care about is when the doc last changed,
  // not when the repo was last pushed — but a rate-limited or forbidden commits
  // call must not lose the concept, so pushed_at is the fallback.
  async function commitDate(generation, repoPath) {
    const { dates, branch, pushedAt } = generation;
    if (dates.has(repoPath)) return dates.get(repoPath);
    let date = pushedAt;
    try {
      const commits = await api(`/repos/${slug}/commits`, {
        search: { path: repoPath, sha: branch, per_page: "1" },
      });
      date = dateOnly(commits?.[0]?.commit?.committer?.date ?? commits?.[0]?.commit?.author?.date) ?? pushedAt;
    } catch {
      // keep pushedAt — a missing history date is not worth dropping the doc over
    }
    dates.set(repoPath, date);
    return date;
  }

  const source = {
    name,
    level,
    async loadConcept(id) {
      const repoPath = withinRepo(id, slug);
      if (!repoPath) return null;
      let generation;
      try {
        generation = await loadIndex(); // records its own failure, as scope "index"
      } catch (e) {
        warn(e);
        return null;
      }
      const entry = generation.entries.get(`${slug}/${repoPath}`);
      if (!entry) return null;
      try {
        const content = await api(`/repos/${slug}/contents/${encodePath(entry.path)}`, {
          raw: true,
          search: { ref: generation.branch },
        });
        if (content == null) return null;
        const updated = await commitDate(generation, entry.path);
        const doc = parseDocument({
          content,
          stem: path.posix.basename(entry.path, entry.ext),
          updated,
          ext: entry.ext,
        });
        if (lastError?.scope === "content") lastError = null; // this file reads fine again
        return doc;
      } catch (e) {
        recordFailure(e, "content"); // the index is fine; this one file isn't readable
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
    // What the read path refuses to say. A resolve must never fail on a down
    // repo, so listConceptIds answers [] whether the repo is empty or GitHub
    // returned 403 — fine for a resolve, wrong for a user who just clicked
    // Sync on this one repo and got a green checkmark. health() is that answer,
    // out of band: a plain snapshot of already-recorded state, no request, no
    // effect on what a read returns.
    health() {
      return {
        ok: lastError === null,
        lastError: lastError ? lastError.message : null,
        lastErrorScope: lastError ? lastError.scope : null, // "index" (repo/tree) | "content" (one file)
        lastErrorAt: lastError ? new Date(lastError.at).toISOString() : null,
        lastSuccessAt: index ? new Date(index.at).toISOString() : null,
        indexedConcepts: index ? index.entries.size : 0,
      };
    },
    // Explicit refresh: drop the index, the commit-date memo, and any failure
    // cooldown so the next read re-fetches immediately. The cache wrapper calls
    // through to this on its own sync(). lastError goes too, so whatever
    // health() reports afterwards belongs to this sync and not to an outage the
    // user has already been told about.
    sync() {
      index = null; // the commit-date memo lives inside it and goes with it
      failure = null;
      warnedAt = 0;
      lastError = null;
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

// The selectors, read as a fetch plan instead of a filter.
//
// GitHub truncates a recursive tree listing at roughly 100k entries or 7MB and
// flags it `truncated`. Filtering `paths` locally can't recover what the
// response omitted, so a repo that big used to be unindexable outright: every
// refresh asked for the whole tree, got a truncated one, and refused it. The
// request is what has to shrink.
//
// Each selector contributes the directory it can't escape — everything before
// its first wildcard segment:
//
//   "docs/**"    -> { docs, recursive }   one subtree call
//   "docs/*.md"  -> { docs, recursive }   a superset; the matchers still filter
//   "CLAUDE.md"  -> { "", flat }          a literal path lives in its parent
//   "**/*.md"    -> { "", recursive }     no prefix to stand on
//
// That last form is the honest fallback: a selector whose first segment is a
// wildcard means the whole tree, exactly as before. When one is present it
// subsumes every other scope, so the plan collapses back to a single whole-tree
// request. The default selectors have no such form — they ask for the root
// level plus docs/ and .context/, and never see the middle of a monorepo.
//
// Exported for tests: this is where a wrong prefix would silently narrow a
// layer, and from the outside a narrowed index just looks like a smaller repo.
export function treeScopes(globs) {
  const scopes = [];
  for (const glob of globs) {
    const segments = String(glob).split("/").filter((s) => s.length && s !== ".");
    const wild = segments.findIndex((s) => s.includes("*") || s.includes("?"));
    const head = wild === -1 ? segments.slice(0, -1) : segments.slice(0, wild);
    // A prefix goes into a request path, so it gets the same treatment the repo
    // slug gets: no path syntax. ".." would be normalized away by the URL
    // parser and silently retarget the call at a different endpoint. Such a
    // selector can't match a git path anyway — git has no ".." entries — so it
    // contributes no scope rather than a rewritten one. When it was the only
    // selector, nothing resolves and fetchIndex says so.
    if (head.includes("..")) continue;
    scopes.push(
      wild === -1
        ? { prefix: head.join("/"), recursive: false }
        : { prefix: head.join("/"), recursive: true },
    );
  }

  const recursive = [...new Set(scopes.filter((s) => s.recursive).map((s) => s.prefix))];
  if (recursive.includes("")) return [{ prefix: "", recursive: true }];
  // A recursive scope already covers everything below it, so "docs/**" plus
  // "docs/adr/**" is one call, not two overlapping ones.
  const roots = recursive.filter((p) => !recursive.some((other) => other !== p && isUnder(p, other)));
  const flat = [...new Set(scopes.filter((s) => !s.recursive).map((s) => s.prefix))]
    .filter((p) => !roots.some((root) => p === root || isUnder(p, root)));
  return [
    ...roots.map((prefix) => ({ prefix, recursive: true })),
    ...flat.map((prefix) => ({ prefix, recursive: false })),
  ];
}

function isUnder(child, parent) {
  return parent !== "" && child.startsWith(`${parent}/`);
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
