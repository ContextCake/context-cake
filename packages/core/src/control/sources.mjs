// Source control operations — the shared validation and mutation behind the
// /api/sources CRUD and the CLI's `source` family
// (specs/contextcake-control-plane/design.md §1). The HTTP service and the
// CLI are parsing shims over these; neither carries its own copy of a probe,
// a mutation, or a refusal message.
//
// Credentials are a capability, not state: the adapter that owns tokens
// injects `gitCredentialsForUrl(url) => secrets[]`, the same one-way flow as
// buildSources' token map — these operations never read a keychain.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { probeDocs } from "../sources/okf-local.mjs";
import { FILES_EXTENSIONS } from "../sources/files.mjs";
import { createMcpSource } from "../sources/mcp.mjs";
import { buildSources } from "../sources/index.mjs";
import {
  classifyManifest,
  getManifestProfileLayers,
  manifestLevel,
  mutateContextManifest,
  quarantineProfileKey,
  readContextManifest,
  readContextManifestQuarantined,
  repairContextManifest,
  syncPackAssignmentLevel,
  validateContextManifest,
  withManifestLockAsync,
} from "../manifest.mjs";
import { ControlError } from "./errors.mjs";
import { revisionPrecondition } from "./profiles.mjs";
import { withDeadline } from "./util.mjs";

// Re-exported for the callers (and tests) that reached it here before it
// moved next to the pack-layer-drift validation it protects.
export { syncPackAssignmentLevel };

const execFileP = promisify(execFile);

// A `level` (or `position`) as a CLIENT sends it on add/patch: a JSON number
// or a numeric string, and a safe integer. Returns the integer, or null when
// the value is not one — `null`, `""`, `"abc"`, `1.5`, `true` all answer
// null. The old `Number.isFinite(+value)` test let `null` through as 0 and
// silently ignored `"abc"`; both are now the caller's LEVEL_INVALID. This is
// input validation only: what a manifest ALREADY holds is read through
// manifestLevel (manifest.mjs), which is looser on purpose — see there.
export function parseLevel(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * Cascade levels for a list of layers given in the order the user wants them
 * to WIN — first entry beats everything below it. Pure; the input is not
 * mutated. Returns `[{ name, level }]` aligned with the input.
 *
 * The engine's precedence stays "higher `level` wins" (resolver.mjs); this is
 * how a rank-shaped request becomes those integers without disturbing what a
 * user's manifest already says where it can be left alone:
 *
 *   - When the layers already carry N distinct levels for N layers, those
 *     same numbers are handed back as a permutation. A 3/2/0 cascade dragged
 *     into a new order stays a permutation of {3, 2, 0} — round-trip stable,
 *     and every doc/fixture default survives a reorder untouched.
 *   - Otherwise (a tie, or a layer with no level yet — an insert) the whole
 *     list is renumbered contiguously N..1. Ties cannot be preserved through a
 *     reorder (a tie IS the absence of an order), and an inserted layer has no
 *     number to reuse, so 2/2/0 becomes 3/2/1 and an add-at-position onto
 *     3/2/0 becomes 4/3/2/1.
 *
 * A level counts as "existing" when the manifest itself would accept it
 * (manifestLevel: a hand-authored `null` is 0, `true` is 1 — the same numbers
 * the resolver ranks them as), so a valid manifest always round-trips as a
 * permutation. A layer with NO level — the newcomer of an insert by position
 * — is not in the pool, which is exactly what makes an insert renumber rather
 * than land on an arbitrary number.
 */
export function assignCascadeLevels(orderedLayers) {
  const layers = Array.isArray(orderedLayers) ? orderedLayers : [];
  const pool = [...new Set(layers.map((layer) => manifestLevel(layer)).filter((level) => level !== null))]
    .sort((a, b) => b - a);
  const total = layers.length;
  return layers.map((layer, index) => ({
    name: layer?.name,
    level: pool.length === total ? pool[index] : total - index,
  }));
}

// The current cascade order of a layer list: level descending, ties broken by
// name (code-point order — `a < b`, not localeCompare, so it is the same on
// every machine) so the answer is deterministic and matches what a rank
// display shows. Used by the add-at-position insert, the only place the
// engine has to derive an order rather than be handed one. Levels are read
// the way the manifest and the resolver read them (manifestLevel: `null` is
// 0, `true` is 1), so an insert lands where the graph says the neighbours
// are; a layer with no level at all sorts as 0.
function cascadeOrder(layers) {
  return [...layers].sort((a, b) => {
    const la = manifestLevel(a) ?? 0;
    const lb = manifestLevel(b) ?? 0;
    if (la !== lb) return lb - la;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

// One wording for "the manifest is broken in a way no default-profile row
// explains" — the reorder op answers it from two places.
function manifestInvalidError(manifestPath, verb, cause) {
  return new ControlError("MANIFEST_INVALID", `Nothing was ${verb}: the manifest is invalid in a way this operation cannot work around. Edit ${manifestPath} by hand — ${cause}`, { status: 409 });
}

// `"name" (error); "name" (error)` — the invalid rows a refusal names, in the
// shape removal and reorder both use.
function formatBlocking(blocking) {
  return blocking.map((entry) => `"${entry.name}" (${entry.error})`).join("; ");
}

// Accept "owner/name", an https URL, or a git@ SSH URL. Reject other schemes —
// git clone otherwise supports dangerous transports (ext::, file://…).
export function normalizeRepo(repo) {
  const r = repo.trim().replace(/\.git$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return { url: `https://github.com/${r}.git`, slug: slugify(r) };
  if (/^https:\/\/[\w.-]+\/[\w./-]+$/.test(r)) return { url: `${r}.git`, slug: slugify(r.replace(/^https:\/\//, "")) };
  if (/^git@[\w.-]+:[\w./-]+$/.test(r)) return { url: `${r}.git`, slug: slugify(r.replace(/^git@/, "")) };
  throw new ControlError("REPO_INVALID", "Repo must be owner/name, an https URL, or git@host:owner/name", { status: 400 });
}

function slugify(s) { return s.replace(/[^\w.-]+/g, "__"); }

// What .replace(/^\/+|\/+$/g, "") did, without rescanning an inner slash run
// from each slash in it.
export function trimSlashes(text) {
  let start = 0;
  while (start < text.length && text[start] === "/") start += 1;
  let end = text.length;
  while (end > start && text[end - 1] === "/") end -= 1;
  return text.slice(start, end);
}

// A pasted "~/notes" reaches the manifest verbatim otherwise, and buildSources
// then resolves a literal "~" directory that doesn't exist.
export function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function defaultProfileContainer(manifest) {
  return classifyManifest(manifest) === "v2" ? manifest.profiles.default : manifest;
}

// The object that holds a profile's `pendingSources`. Every operation takes a
// `profileId` (null = default, the only one the HTTP service reads) and never
// derives one itself; getManifestProfileLayers checks the id exists first.
function profileContainer(manifest, profileId) {
  if ((profileId ?? "default") === "default") return defaultProfileContainer(manifest);
  return manifest.profiles[profileId];
}

// A stale --expect-revision fails before a probe or a clone does any work.
// The same check runs again under the lock, where it counts.
function precheckRevision(manifestPath, expectRevision) {
  const precondition = revisionPrecondition(expectRevision);
  if (!precondition) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return precondition; // unreadable: the operation's own read reports it
  }
  precondition(raw);
  return precondition;
}

function isTokenEnvAuth(auth) {
  return Boolean(auth) && typeof auth === "object" && !Array.isArray(auth)
    && Object.keys(auth).length === 1 && typeof auth.tokenEnv === "string"
    && /^[A-Za-z_][A-Za-z0-9_]*$/.test(auth.tokenEnv);
}

function isScrubMarker(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof value.__scrubbed === "string";
}

// Plain errors a caller maps to its own codes (MANIFEST_LOCKED,
// PROFILE_NOT_FOUND). Never rewrap them as "the manifest is invalid".
function isLockOrProfileError(err) {
  return /^Unknown ContextCake profile|^Timed out acquiring the ContextCake manifest lock/.test(String(err?.message ?? ""));
}

function cloneDirOccupied(dir) {
  return new ControlError("CLONE_DIR_OCCUPIED", `${dir} exists but is not a git clone. Move it aside and try again.`, { status: 409, detail: { dir } });
}

// Carries a staged clone from the probe to the locked promote without letting
// it reach the manifest: a symbol key is never serialized.
const PROMOTE = Symbol("promote");

function removePendingSource(container, name) {
  if (!Array.isArray(container.pendingSources)) return;
  container.pendingSources = container.pendingSources.filter((pending) => pending?.name !== name);
  if (container.pendingSources.length === 0) {
    delete container.pendingSources;
    delete container.pendingSourcesOwnerUserId;
  }
}

// Add-time folder validation, deliberately cheap. Only the two things the
// user can fix on the form are errors here: the folder has to exist and be a
// folder. Size is NOT checked — a big folder is a normal thing to add, and
// making the user wait for a full walk before the app opens is the hang this
// whole path exists to avoid. The shallow probe just reports whether any
// documents were spotted, so the wizard can warn about an empty folder
// without indexing it.
export async function probeFolder(abs, extensions) {
  let st;
  try { st = await fsp.stat(abs); } catch { throw new ControlError("FOLDER_NOT_FOUND", `Folder not found: ${abs}`, { status: 400 }); }
  if (!st.isDirectory()) throw new ControlError("NOT_A_FOLDER", `Not a folder: ${abs}`, { status: 400 });
  const controller = new AbortController();
  try {
    // The deadline has to reach the walk, not just the promise: without the
    // signal a probe of a slow or enormous folder answers the form in 5s and
    // then keeps scanning in the background, competing with the index the add
    // just started.
    return await withDeadline(
      probeDocs(abs, extensions, undefined, { signal: controller.signal }),
      5_000,
      "probe timed out",
      () => controller.abort(new Error("Folder probe timed out")),
    );
  } catch {
    return { found: false, scanned: 0, complete: false }; // slow disk — let the background index decide
  }
}

// Add-time github-rest validation: one bounded, anonymous request. A definite
// "that repo isn't public" (404, or 403 — the shape GitHub also uses for rate
// limits and blocked repos) fails the form with a pointer at the private-repo
// option; anything network-shaped writes the layer anyway — the cheap-add
// doctrine: the background index runs next and health() marks the source
// degraded with the real error, instead of an offline laptop blocking setup.
// The env override exists for the network-free test suite only; the manifest
// layer this operation writes never carries an apiBase.
async function probeGithubRest(slug, token = null) {
  const base = process.env.CONTEXTCAKE_GITHUB_PROBE_BASE || "https://api.github.com";
  let res;
  try {
    res = await fetch(`${base}/repos/${slug}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "contextcake",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000), // mirrors the adapter's request timeout
    });
  } catch {
    return; // unreachable — fail open, the first index reports health honestly
  }
  if (res.status === 404 || res.status === 403) {
    if (token) throw new ControlError("REPO_NOT_FOUND", "repo not found, or the token cannot read it", { status: 400 });
    throw new ControlError("REPO_NOT_PUBLIC", "repo not found or not public — for private repos use the Private repo (git) option", { status: 400 });
  }
}

// Add-time MCP validation: spawn the command and require an answer to
// tools/list (bounded by the adapter's own timeouts) before the manifest is
// written. A wrong command fails the form in seconds; the old behavior was a
// silently-empty source. The probe also checks the answer: a server that
// responds but lacks the two graph tools would otherwise pass the form and
// become a permanently empty source — the exact silence the probe exists to
// prevent.
async function probeMcp({ name, level, command, args }) {
  const probe = createMcpSource({ name, level, command, args });
  try {
    await probe.probe();
  } catch (err) {
    if (err.code === "CONTRACT") {
      throw new ControlError("MCP_CONTRACT", "This MCP server responded but doesn't speak the ContextCake graph contract (needs list_nodes and get_node tools).", { status: 400 });
    }
    throw new ControlError("MCP_UNREACHABLE", `The MCP server did not respond (${err.message}). Check the command and try again.`, { status: 400 });
  } finally {
    probe.close();
  }
}

/**
 * Which layers may have their folder repointed, and why the rest may not.
 * A remote source has no folder to speak of, and a clone-backed layer's path
 * is owned by Sync (gitCloneOrPull writes CACHE_DIR/<slug>, never layer.path)
 * — repointing it would leave a source that reads one folder and syncs
 * another, which is worse than refusing.
 */
export function pathPatchRefusal(layer) {
  const kind = layer.source ?? "okf-local";
  if (kind === "mcp") return "An MCP source is reached by command, not by folder. Remove it and add it again to point at a different server.";
  if (kind === "github") return "A GitHub source is read from its repository, not from a folder on this machine. Remove it and add it again to point at a different repo.";
  if (layer.origin) return "This source is a clone of " + layer.origin + ". Its folder is managed by Sync — remove it and add it again to point somewhere else.";
  if (kind !== "okf-local" && kind !== "files") return `A "${kind}" source has no editable folder path.`;
  return null;
}

// Auth failures from git are wordy and blame the wrong thing ("could not read
// Username"). The operation turns them into one flag the UI can act on,
// because the fix is a specific action — connect an account — not a retry.
function looksLikeAuthFailure(text) {
  return /authentication failed|could not read (username|password)|terminal prompts disabled|repository not found|403|401/i.test(text);
}

/**
 * Adapter policy is fixed per adapter, not per request:
 *
 *   retainClones   `source remove` keeps a managed clone it no longer needs
 *                  (control-plane spec §5.12) and reports it; pruneClones is
 *                  the separate, confirmed delete. The HTTP service keeps its
 *                  old behavior (delete an unreferenced clone) because the app
 *                  has no prune yet.
 *   acceptTokenEnv a `github-rest` add may name `auth: {tokenEnv}`, the
 *                  headless credential path. The app's public-repo form still
 *                  refuses auth (see addSource).
 *   env            where that tokenEnv value is read for the add-time probe.
 *
 * Per-call context is each operation's last argument:
 * `{ profileId, expectRevision }`, where a null profileId means default.
 */
export function createSourceOperations({
  manifestPath,
  gitCredentialsForUrl = () => [],
  retainClones = false,
  acceptTokenEnv = false,
  env = process.env,
}) {
  const MANIFEST = path.resolve(manifestPath);
  const MANIFEST_DIR = path.dirname(MANIFEST);
  // Git-backed sources clone next to the manifest that declares them.
  const CACHE_DIR = path.join(MANIFEST_DIR, ".cache", "repos");
  // A fresh clone lands here first, and moves into CACHE_DIR only after the
  // manifest is revalidated under the lock (§5.12). Same filesystem, so the
  // move is a rename.
  const STAGING_DIR = path.join(CACHE_DIR, ".staging");

  async function addSource(b, { profileId = null, expectRevision = null } = {}) {
    const name = String(b.name ?? "").trim();
    if (!/^[a-zA-Z0-9 _-]{1,40}$/.test(name)) throw new ControlError("NAME_INVALID", "Name: letters/numbers/space/_/- (max 40)", { status: 400 });
    const precondition = precheckRevision(MANIFEST, expectRevision);
    const initialManifest = readContextManifest(MANIFEST, { allowMissing: false });
    if (getManifestProfileLayers(initialManifest, profileId).some((l) => l.name === name)) throw new ControlError("SOURCE_EXISTS", `A source named "${name}" already exists`, { status: 409 });
    // Two ways to say where the new layer sits, never both: `level` is the raw
    // manifest integer (omitted → 1, unchanged); `position` is a 1-based rank
    // in the cascade (1 = wins over everything, N+1 = bottom), turned into
    // levels for the whole list inside the mutation below.
    if (b.level !== undefined && b.position !== undefined) {
      throw new ControlError("LEVEL_AND_POSITION", "Give either level or position, not both", { status: 400 });
    }
    let level = 1;
    if (b.level !== undefined) {
      const parsed = parseLevel(b.level);
      if (parsed === null) throw new ControlError("LEVEL_INVALID", "level must be an integer", { status: 400 });
      level = parsed;
    }
    let position = null;
    if (b.position !== undefined) {
      position = parseLevel(b.position);
      if (position === null || position < 1) throw new ControlError("POSITION_INVALID", "position must be an integer of 1 or more (1 = top of the cascade)", { status: 400 });
      // Assigned by position below. `undefined`, not `null`: a null level is a
      // legal manifest value (it reads as 0), and the newcomer must be the one
      // layer NOT in the existing-level pool so the insert renumbers.
      level = undefined;
    }

    let layer;
    let folder = null;
    let tokenEnvSet = null;
    // A fresh clone waiting in STAGING_DIR for the locked promote below.
    let promote = null;
    if (b.kind === "local" || b.kind === "files") {
      if (!b.path) throw new ControlError("PATH_REQUIRED", "Local source needs a path", { status: 400 });
      const given = expandHome(String(b.path).trim());
      folder = await probeFolder(path.resolve(MANIFEST_DIR, given), b.kind === "files" ? FILES_EXTENSIONS : [".md"]);
      layer = {
        name,
        level,
        path: given,
        ...(b.kind === "files" ? { source: "files" } : {}),
      };
    } else if (b.kind === "mcp") {
      if (!b.command) throw new ControlError("MCP_COMMAND_REQUIRED", "MCP source needs a command", { status: 400 });
      if (b.trusted !== true) {
        throw new ControlError("MCP_TRUST_REQUIRED", "Confirm that this MCP command came from a trusted source", { status: 400 });
      }
      const args = Array.isArray(b.args) ? b.args.map(String) : String(b.args ?? "").split(/\s+/).filter(Boolean);
      const command = String(b.command);
      // Probe with the same arg resolution buildSources applies, so the check
      // exercises exactly what the layer will run.
      const probeArgs = args.map((a) => (a.startsWith("./") || a.startsWith("../") ? path.resolve(MANIFEST_DIR, a) : a));
      await probeMcp({ name, level, command, args: probeArgs });
      layer = { name, level, source: "mcp", command, args };
    } else if (b.kind === "github-rest") {
      // The "Public repo" wizard path: a REST-read layer, no clone. This form
      // deliberately writes an anonymous github layer, so auth/apiBase are
      // rejected rather than silently ignored. Private repos take the git-clone
      // kind in the wizard; authenticated REST layers remain an explicit
      // manifest feature because they must name the intended credential alias.
      // The exception is a headless adapter (acceptTokenEnv) naming an
      // environment variable. That reference never waits on a keychain alias
      // the app has not injected, so it cannot read anonymously by surprise.
      const tokenEnvAuth = acceptTokenEnv && isTokenEnvAuth(b.auth) ? b.auth : null;
      if ((b.auth !== undefined && !tokenEnvAuth) || b.apiBase !== undefined) {
        throw new ControlError("REST_AUTH_REJECTED", "A public-repo source reads anonymously — remove auth/apiBase. For private repos use the Private repo (git) option.", { status: 400 });
      }
      const slug = String(b.repo ?? "").trim();
      const parts = slug.split("/");
      if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..")) {
        throw new ControlError("REPO_INVALID", 'Repo must be "owner/name"', { status: 400 });
      }
      if (b.paths !== undefined && (!Array.isArray(b.paths) || b.paths.some((p) => typeof p !== "string"))) {
        throw new ControlError("PATHS_INVALID", "paths must be an array of strings", { status: 400 });
      }
      const token = tokenEnvAuth ? (env[tokenEnvAuth.tokenEnv] || null) : null;
      // A variable unset here may still be set where the source is served, so
      // skip the probe rather than call a private repo missing.
      if (!tokenEnvAuth || token) await probeGithubRest(slug, token);
      if (tokenEnvAuth) tokenEnvSet = Boolean(token);
      layer = {
        name,
        level,
        source: "github",
        repo: slug,
        ...(b.ref ? { ref: String(b.ref) } : {}),
        ...(Array.isArray(b.paths) && b.paths.length ? { paths: b.paths } : {}),
        ...(tokenEnvAuth ? { auth: { tokenEnv: tokenEnvAuth.tokenEnv } } : {}),
        cache: { ttlSeconds: 900 },
      };
    } else if (b.kind === "github") {
      const { url, slug } = normalizeRepo(String(b.repo ?? ""));
      const dir = path.join(CACHE_DIR, slug);
      const sub = b.subdir ? trimSlashes(String(b.subdir)) : "";
      // The sub-directory must stay inside the clone — otherwise this field would
      // set a new sandbox root (layer.path) pointing anywhere on disk. Pure path
      // math, so it is checked before anything is cloned.
      let abs = dir;
      if (sub) {
        abs = path.resolve(dir, sub);
        if (abs !== dir && !abs.startsWith(dir + path.sep)) throw new ControlError("SUBDIR_ESCAPES", "Sub-directory escapes the repository", { status: 400 });
      }
      const ref = b.ref ? String(b.ref) : null;
      if (fs.existsSync(path.join(dir, ".git"))) {
        // Another layer already reads this clone: refresh it in place.
        await gitCloneOrPull(url, dir, ref);
        folder = await probeFolder(abs, [".md"]);
      } else {
        if (fs.existsSync(dir)) throw cloneDirOccupied(dir);
        const staged = path.join(STAGING_DIR, `${slug}-${randomUUID().slice(0, 8)}`);
        fs.mkdirSync(STAGING_DIR, { recursive: true });
        await gitCloneOrPull(url, staged, ref);
        promote = { staged, dir };
        try {
          folder = await probeFolder(path.join(staged, path.relative(dir, abs)), [".md"]);
        } catch (err) {
          fs.rmSync(staged, { recursive: true, force: true });
          throw err;
        }
      }
      layer = { name, level, path: path.relative(MANIFEST_DIR, abs), origin: url, ref: b.ref || null };
    } else {
      throw new ControlError("KIND_UNKNOWN", `Unknown source kind: ${b.kind}`, { status: 400 });
    }

    let placed;
    try {
      placed = mutateContextManifest(MANIFEST, (manifest) => {
        const layers = getManifestProfileLayers(manifest, profileId);
        if (layers.some((candidate) => candidate.name === name)) throw new ControlError("SOURCE_EXISTS", `A source named "${name}" already exists`, { status: 409 });
        let order = null;
        if (position !== null) {
          // Insert into the CURRENT cascade order (by level, not array order —
          // position is a rank), clamped to the bottom, then re-level the whole
          // list. Existing layers get renumbered N..1 around the newcomer.
          const ordered = cascadeOrder(layers);
          ordered.splice(Math.min(position, ordered.length + 1) - 1, 0, layer);
          order = applyCascadeLevels(manifest, ordered, profileId);
        }
        layers.push(layer);
        // A synced source whose machine-local path/command was scrubbed waits in
        // pendingSources. Configuring that source locally promotes it to a runnable
        // layer without leaving a duplicate metadata-only record behind.
        removePendingSource(profileContainer(manifest, profileId), name);
        // The last step before the write, on a manifest revalidated under the
        // lock: move the staged clone into place. When a concurrent add already
        // promoted the same repository, read that clone and drop ours. If the
        // write below fails, a promoted clone stays behind unreferenced for
        // pruneClones to find; it is never deleted here.
        if (promote) {
          if (fs.existsSync(path.join(promote.dir, ".git"))) fs.rmSync(promote.staged, { recursive: true, force: true });
          else if (fs.existsSync(promote.dir)) throw cloneDirOccupied(promote.dir);
          else fs.renameSync(promote.staged, promote.dir);
        }
        return order;
      }, { allowMissing: false, allowTransitional: true, precondition });
    } finally {
      // Refused under the lock (stale revision, name taken): the staged clone
      // never became anyone's, so it goes.
      if (promote && fs.existsSync(promote.staged)) fs.rmSync(promote.staged, { recursive: true, force: true });
    }
    return {
      ok: true,
      added: name,
      level: layer.level,
      indexing: true, // counts arrive via /api/graph as the index lands
      ...(placed ? { order: placed } : {}),
      ...(folder ? { hasDocuments: folder.found, scanComplete: folder.complete } : {}),
      ...(tokenEnvSet !== null ? { tokenEnvSet } : {}),
    };
  }

  // Write the levels assignCascadeLevels chose onto the layer objects, keeping
  // every Pack assignment in step. Returns the [{name, level}] list.
  function applyCascadeLevels(manifest, orderedLayers, profileId = null) {
    const assigned = assignCascadeLevels(orderedLayers);
    orderedLayers.forEach((layer, index) => {
      layer.level = assigned[index].level;
      syncPackAssignmentLevel(manifest, layer, profileId);
    });
    return assigned;
  }

  /**
   * Reorder the cascade: `order` is the complete list of the default
   * profile's source names, first wins. Levels are reassigned by
   * assignCascadeLevels (a permutation of the existing distinct levels when
   * there are enough of them, N..1 otherwise) and every Pack assignment moves
   * with its layer, so the strict write cannot refuse on pack-layer-drift.
   *
   * Refused, not worked around, when a quarantined layer exists in the
   * profile: a reorder is a whole-cascade statement, and a layer the read path
   * had to lift out has no rank to give it — the same 409 shape removeSources
   * answers with, listing what blocks it. Re-leveling never re-indexes:
   * `level` is a presentation field outside the index identity.
   */
  function reorderSources(body, { profileId = null, expectRevision = null } = {}) {
    // A `null` body parses fine and would otherwise be a TypeError (500) at
    // the destructure; it is just another shape of "no order given".
    const order = body && typeof body === "object" ? body.order : undefined;
    if (!Array.isArray(order) || order.some((name) => typeof name !== "string" || !name)) {
      throw new ControlError("ORDER_INVALID", "order must be an array of source names", { status: 400, detail: { unknown: [], missing: [], duplicate: [] } });
    }
    const duplicate = [...new Set(order.filter((name, index) => order.indexOf(name) !== index))];
    if (duplicate.length) {
      throw new ControlError("ORDER_INVALID", `order names a source more than once: ${duplicate.join(", ")}`, { status: 400, detail: { unknown: [], missing: [], duplicate } });
    }
    // Tolerant read first: the strict read inside the mutation would throw the
    // engine's raw validation error at a manifest holding a bad layer, and the
    // caller is owed the same "which rows block this" answer removal gives.
    refuseIfQuarantined(profileId);
    let assigned;
    try {
      assigned = mutateContextManifest(MANIFEST, (manifest) => {
        const layers = getManifestProfileLayers(manifest, profileId);
        const names = new Set(layers.map((layer) => layer.name));
        const unknown = order.filter((name) => !names.has(name));
        const missing = layers.map((layer) => layer.name).filter((name) => !order.includes(name));
        if (unknown.length || missing.length) {
          const parts = [];
          if (unknown.length) parts.push(`unknown: ${unknown.join(", ")}`);
          if (missing.length) parts.push(`missing: ${missing.join(", ")}`);
          throw new ControlError("ORDER_INVALID", `order must name every source in the profile exactly once (${parts.join("; ")})`, { status: 400, detail: { unknown, missing, duplicate: [] } });
        }
        const byName = new Map(layers.map((layer) => [layer.name, layer]));
        return applyCascadeLevels(manifest, order.map((name) => byName.get(name)), profileId);
      }, { allowMissing: false, allowTransitional: true, precondition: revisionPrecondition(expectRevision) });
    } catch (err) {
      if (err instanceof ControlError || err.status) throw err;
      if (isLockOrProfileError(err)) throw err;
      // The strict read (or the strict write) refused the manifest for a
      // reason no default-profile row explains — a bad layer in ANOTHER
      // profile, two layers sharing a name, a dangling Pack — or a row went
      // bad between the tolerant read above and the lock. Neither is an
      // internal failure; say which, the way removal and settings do.
      refuseIfQuarantined(profileId);
      throw manifestInvalidError(MANIFEST, "reordered", err.message);
    }
    return { ok: true, order: assigned };
  }

  // The reorder's 409: every quarantined row in the default profile, listed
  // by the name the graph shows it under (like REMOVE_BLOCKED). A read that
  // cannot even quarantine (whole-manifest failure) throws the engine's own
  // error, which the caller maps to MANIFEST_INVALID.
  function refuseIfQuarantined(profileId = null) {
    let manifest;
    let quarantined;
    try {
      ({ manifest, quarantined } = readContextManifestQuarantined(MANIFEST, { allowMissing: false }));
    } catch (err) {
      throw manifestInvalidError(MANIFEST, "reordered", err.message);
    }
    const key = quarantineProfileKey(manifest, profileId);
    const blocking = quarantined.filter((entry) => entry.profileId === key);
    if (blocking.length) {
      const listed = formatBlocking(blocking);
      throw new ControlError("REORDER_BLOCKED", `Nothing was reordered: ${blocking.length} source${blocking.length === 1 ? " is" : "s are"} invalid and cannot be given a position. Remove ${blocking.length === 1 ? "it" : "them"} first — ${listed}`, { status: 409, detail: { blocking: blocking.map((entry) => ({ name: entry.name, error: entry.error })) } });
    }
  }

  /**
   * The one repair operation. It reads through repairContextManifest rather
   * than mutateContextManifest, so a quarantined layer — the row /api/graph
   * shows as an error — can be taken out from the app. Everything about what
   * may be WRITTEN is unchanged: repairContextManifest validates the whole
   * manifest before the file is touched.
   *
   * Names may repeat, and that is not a convenience. What may be persisted
   * is a VALID manifest, so with two invalid entries present, removing either
   * one on its own is refused — the remaining one still fails validation. A
   * manifest with several bad layers would be unrepairable from the app, which
   * is the situation this whole path exists to end. Removing them in one
   * transaction is the only shape that both fixes the file and keeps the write
   * strict. The 409 below says so when a client asked for too little.
   */
  //
  // `pendingOnly` is `source pending-dismiss`: the same all-or-nothing
  // transaction, limited to pending entries so a typo cannot take a runnable
  // source with it.
  function removeSources(names, { profileId = null, expectRevision = null, pendingOnly = false } = {}) {
    const wanted = [...new Set(names.filter((name) => typeof name === "string" && name))];
    if (wanted.length === 0) throw new ControlError("NAME_REQUIRED", "Provide ?name=", { status: 400 });
    const removed = [];
    let survivors = [];
    let blocking = [];
    try {
      repairContextManifest(MANIFEST, ({ manifest, layers, quarantined, quarantineKey }) => {
        const container = profileContainer(manifest, profileId);
        // Quarantined rows for the profile this operation reads. A layer
        // quarantined out of some OTHER profile has no row here to have been
        // clicked, and removing it is not this route's business.
        const broken = quarantined.filter((entry) => entry.profileId === quarantineKey);
        // A set, because these become splices: two names resolving to one index
        // would take a second, innocent layer with them.
        const doomed = new Set();
        for (const name of wanted) {
          const pendingBefore = container.pendingSources?.length ?? 0;
          removePendingSource(container, name);
          const droppedPending = (container.pendingSources?.length ?? 0) !== pendingBefore;
          if (pendingOnly) {
            if (!droppedPending) throw new ControlError("PENDING_NOT_FOUND", `No pending source named "${name}"`, { status: 404 });
            continue;
          }
          const index = layers.findIndex((layer) => layer.name === name);
          if (index >= 0) { doomed.add(index); continue; }
          // A quarantined row is matched on the name the graph gave it, which
          // may be synthesized, and removed at the index that name was minted
          // for — see the record's `index`. Valid layers win the name first, so
          // this can never shadow a healthy row.
          const entry = broken.find((candidate) => candidate.name === name);
          if (entry) { doomed.add(entry.index); continue; }
          if (!droppedPending) throw new ControlError("SOURCE_NOT_FOUND", `No source named "${name}"`, { status: 404 });
        }
        // Descending, so each splice leaves the indices below it alone.
        for (const index of [...doomed].sort((a, b) => b - a)) {
          removed.push(layers[index]);
          layers.splice(index, 1);
        }
        // What the write is about to reject on, if it rejects: every invalid
        // entry the caller did NOT ask to remove.
        blocking = broken.filter((entry) => !doomed.has(entry.index));
        survivors = allManifestLayers(manifest); // every profile — a shared clone must survive
      }, { allowTransitional: true, profileId, precondition: revisionPrecondition(expectRevision) });
    } catch (err) {
      if (err.status) throw err;
      if (isLockOrProfileError(err)) throw err;
      if (blocking.length > 0) {
        const listed = formatBlocking(blocking);
        throw new ControlError("REMOVE_BLOCKED", `Nothing was removed: ${blocking.length} other source${blocking.length === 1 ? " is" : "s are"} also invalid, and the manifest cannot be saved while ${blocking.length === 1 ? "it remains" : "they remain"}. Remove ${blocking.length === 1 ? "it" : "them"} in the same request — ${listed}`, { status: 409 });
      }
      // A manifest broken in a way no single layer explains (two layers sharing
      // a name, a malformed profiles block) is not repairable from here, and an
      // internal error would read as "the app is broken" rather than "your file
      // is". Say which, and keep the engine's own message — it names the actual
      // defect.
      throw new ControlError("MANIFEST_UNREPAIRABLE", `Nothing was removed: the manifest is invalid in a way this app cannot repair. Edit ${MANIFEST} by hand — ${err.message}`, { status: 409 });
    }
    const retained = [];
    for (const layer of removed) {
      const dir = cleanupCloneDir(layer, survivors);
      if (dir && !retained.includes(dir)) retained.push(dir);
    }
    return { ok: true, removed: wanted[0], removedNames: wanted, ...(retained.length ? { retainedClones: retained } : {}) };
  }

  // Every layer the manifest still declares, across the legacy array and every
  // profile — the audience whose paths can keep a clone directory alive.
  function allManifestLayers(manifest) {
    const out = [...(manifest.layers ?? [])];
    for (const profile of Object.values(manifest.profiles ?? {})) out.push(...(profile.layers ?? []));
    return out;
  }

  // A wizard-cloned repo lives in app-managed disk under .cache/repos, so
  // removing its layer removes the clone — unless another layer (any profile)
  // still resolves inside that directory, e.g. two sub-directory layers over
  // one repo. Every other kind points at the user's own folder and is never
  // touched. Best effort: an undeletable orphan dir is not worth failing the
  // remove that already happened.
  //
  // Under retainClones nothing is deleted: the orphan's path comes back so the
  // caller can say it was kept and point at pruneClones.
  function cleanupCloneDir(layer, survivors) {
    const dir = cloneDirOf(layer);
    if (!dir) return null;
    const inUse = survivors.some((candidate) => {
      if (typeof candidate?.path !== "string") return false;
      const resolved = path.resolve(MANIFEST_DIR, candidate.path);
      return resolved === dir || resolved.startsWith(dir + path.sep);
    });
    if (inUse) return null;
    if (retainClones) return fs.existsSync(dir) ? dir : null;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* orphan dir stays; the manifest entry is already gone */ }
    return null;
  }

  // The clone directory a layer's origin maps to — null unless the layer is a
  // clone-backed github layer whose own path actually lives under CACHE_DIR
  // (a pack: origin, a REST layer, or a hand-retargeted path all bail out).
  function cloneDirOf(layer) {
    if (!layer || typeof layer.origin !== "string" || typeof layer.path !== "string") return null;
    let slug;
    try { ({ slug } = normalizeRepo(layer.origin)); } catch { return null; }
    const dir = path.join(CACHE_DIR, slug);
    if (!dir.startsWith(CACHE_DIR + path.sep)) return null;
    const resolved = path.resolve(MANIFEST_DIR, layer.path);
    if (resolved !== dir && !resolved.startsWith(dir + path.sep)) return null;
    return dir;
  }

  async function patchSource(b, { profileId = null, expectRevision = null } = {}) {
    // A path change is validated before the manifest is touched, with the same
    // cheap probe the add path uses — folder-missing and not-a-folder fail the
    // request, size never does. The kind is re-checked inside the mutation
    // below; this read only decides which extensions the probe looks for.
    // `level` is validated before anything is probed or locked: a JSON number
    // or numeric string that is a safe integer, or the request is refused.
    // (Was `Number.isFinite(+b.level)`, which turned `null` into level 0 and
    // silently ignored "abc".) No range check and duplicates stay legal — a
    // hand-authored manifest may hold either; the reorder op is the path that
    // guarantees distinct levels.
    let nextLevel;
    if (b.level !== undefined) {
      nextLevel = parseLevel(b.level);
      if (nextLevel === null) throw new ControlError("LEVEL_INVALID", "level must be an integer", { status: 400 });
    }
    const precondition = precheckRevision(MANIFEST, expectRevision);
    let nextPath;
    let probed = null;
    if (b.path !== undefined) {
      // Typed before it is coerced: String(["/etc"]) is "/etc", so an array
      // would otherwise walk straight through the trim and the probe.
      if (typeof b.path !== "string") throw new ControlError("PATH_REQUIRED", "Give this source a folder path", { status: 400 });
      const layer = getManifestProfileLayers(readContextManifest(MANIFEST, { allowMissing: false }), profileId).find((candidate) => candidate.name === b.name);
      if (!layer) throw new ControlError("SOURCE_NOT_FOUND", `No source named "${b.name}"`, { status: 404 });
      const refusal = pathPatchRefusal(layer);
      if (refusal) throw new ControlError("PATCH_REFUSED", refusal, { status: 400 });
      nextPath = expandHome(b.path.trim());
      if (!nextPath) throw new ControlError("PATH_REQUIRED", "Give this source a folder path", { status: 400 });
      const kind = layer.source ?? "okf-local";
      probed = await probeFolder(path.resolve(MANIFEST_DIR, nextPath), kind === "files" ? FILES_EXTENSIONS : [".md"]);
    }
    mutateContextManifest(MANIFEST, (manifest) => {
      const layers = getManifestProfileLayers(manifest, profileId);
      const layer = layers.find((candidate) => candidate.name === b.name);
      if (!layer) throw new ControlError("SOURCE_NOT_FOUND", `No source named "${b.name}"`, { status: 404 });
      if (nextPath !== undefined) {
        const refusal = pathPatchRefusal(layer);
        if (refusal) throw new ControlError("PATCH_REFUSED", refusal, { status: 400 });
        layer.path = nextPath;
      }
      if (nextLevel !== undefined) {
        layer.level = nextLevel;
        // A Pack layer's level lives in two places; moving one without the
        // other makes the strict write refuse this very patch.
        syncPackAssignmentLevel(manifest, layer, profileId);
      }
      if (b.newName && b.newName !== b.name) {
        if (!/^[a-zA-Z0-9 _-]{1,40}$/.test(b.newName)) throw new ControlError("NAME_INVALID", "Invalid new name", { status: 400 });
        if (layers.some((candidate) => candidate.name === b.newName)) throw new ControlError("NAME_EXISTS", "Name already exists", { status: 409 });
        layer.name = b.newName;
      }
    }, { allowMissing: false, allowTransitional: true, precondition });
    // A new folder is a new content IDENTITY, so adoptIndexes finds no entry to
    // carry over and the source re-indexes from scratch. That is the correct
    // outcome, not a shortcoming of adoption: the snapshot it would have
    // carried is an index of a folder this source no longer reads, and serving
    // it would answer with documents the user just pointed away from. The
    // client is told to expect a re-index rather than left to infer it from a
    // row that flipped back to "indexing".
    return { ok: true, ...(probed ? { reindexing: true, hasDocuments: probed.found, scanComplete: probed.complete } : {}) };
  }

  async function gitCloneOrPull(url, dir, ref) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const secrets = gitCredentialsForUrl(url);
    const attempts = secrets.length ? secrets : [null];
    const pulling = fs.existsSync(path.join(dir, ".git"));

    // Two things matter here beyond "the clone works".
    //
    // First, the credential must not outlive this command. Git's helper chain
    // is cumulative and normally ends at osxkeychain, so simply supplying a
    // token would have git WRITE it into the login keychain — a copy outside
    // our own store, keyed to the host, surviving uninstall and invisible to
    // the app's own disconnect. Setting credential.helper to empty first
    // clears the inherited chain; the one-shot below is then the only helper,
    // and it stores nothing.
    //
    // Second, the secret rides the child's environment rather than argv: the
    // helper *text* is visible in `ps`, the value it dereferences is not.
    // GIT_TRACE and friends are stripped for the same reason — a tracing
    // variable already in the user's shell would otherwise dump the exchange.
    let lastError = null;
    for (let i = 0; i < attempts.length; i += 1) {
      const secret = attempts[i];
      const config = [];
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (/^GIT_(TRACE|CURL_VERBOSE)/i.test(key)) delete env[key];
      }
      env.GIT_TERMINAL_PROMPT = "0"; // never block on an invisible prompt
      env.GIT_CONFIG_NOSYSTEM = "1"; // system config can't inject a helper either
      if (secret) {
        env.CC_GIT_TOKEN = secret;
        config.push(
          "-c", "credential.helper=",
          "-c", 'credential.helper=!f() { echo username=x-access-token; echo "password=$CC_GIT_TOKEN"; }; f',
        );
      }

      try {
        if (pulling) {
          await execFileP("git", [...config, "-C", dir, "pull", "--ff-only"], { timeout: 60000, env });
        } else {
          const args = [...config, "clone", "--depth", "1"];
          if (ref) args.push("--branch", ref);
          args.push(url, dir);
          await execFileP("git", args, { timeout: 120000, env });
        }
        return;
      } catch (err) {
        lastError = err;
        const text = String(err.stderr || err.message || "");
        const retryingAnotherAccount = looksLikeAuthFailure(text) && i < attempts.length - 1;
        // A failed or timed-out clone may leave a partial app-managed
        // directory. Remove it even after the final attempt so a later user
        // retry does not fail with "destination path already exists" instead
        // of retrying the remote.
        if (!pulling) {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the git failure remains the useful error */ }
        }
        if (!retryingAnotherAccount) break;
      }
    }

    if (lastError) {
      let text = String(lastError.stderr || lastError.message || "");
      // The token should never appear in git's output, but this error string
      // reaches an HTTP response body — so make it structurally impossible
      // rather than merely unlikely.
      for (const secret of secrets) text = text.split(secret).join("[redacted]");
      const detail = text.trim().split("\n").pop();
      const needsAuth = looksLikeAuthFailure(text);
      throw new ControlError("GIT_FAILED", `git failed: ${detail}`, {
        status: 502,
        detail: {
          needsAuth,
          ...(needsAuth && secrets.length === 0 ? { hint: "This repository looks private. Connect a GitHub account in Settings → Connections, then try again." } : {}),
          ...(needsAuth && secrets.length > 0 ? { hint: "None of the connected GitHub accounts can access this repository. Check their access, or connect a different account." } : {}),
        },
      });
    }
  }

  /**
   * Sync one source (POST /api/sources/sync, `contextcake source sync`). The
   * caller owns the adapters: `layers` and `sources` are the selected
   * profile's, already built, and `invalidate(name)` / `reload()` are how the
   * caller's own index learns that content moved. Throws SYNC_FAILED (502)
   * with the health detail when the remote could not be read.
   */
  async function syncSource(name, { layers = [], sources = [], invalidate = () => {}, reload = () => {} } = {}) {
    if (!name) throw new ControlError("NAME_REQUIRED", "Provide ?name=", { status: 400 });
    const layer = layers.find((l) => l.name === name);
    if (!layer) throw new ControlError("SOURCE_NOT_FOUND", `No source named "${name}"`, { status: 404 });
    if (layer.source === "github") {
      const source = sources.find((candidate) => candidate.name === name);
      if (!source || typeof source.sync !== "function") {
        throw new ControlError("SYNC_UNSUPPORTED", `"${name}" does not support Sync`, { status: 400 });
      }
      const lastSynced = await source.sync();
      // sync() invalidates both the outer cache and the adapter's internal
      // index. Refresh now so a successful answer means the remote index has
      // actually bypassed TTL rather than merely being marked dirty.
      const concepts = (await source.listConceptIds()).length;
      // Remote adapters swallow API failures on purpose — one unreachable repo
      // must never fail a resolve — which makes an outage look exactly like an
      // empty repo from out here: no throw, no concepts. Everywhere else that's
      // the right trade; here it isn't, because the user asked about this one
      // repo and is owed the answer. health() is the out-of-band channel for it,
      // and sync() cleared it first, so what it reports belongs to this sync.
      const health = typeof source.health === "function" ? source.health() : null;
      const detail = {
        synced: name,
        concepts,
        lastSynced: source.lastSynced ?? lastSynced ?? null, // when this attempt ran
        lastSuccessAt: health?.lastSuccessAt ?? null, // when the index last actually loaded
        lastError: health?.lastError ?? null,
        lastErrorAt: health?.lastErrorAt ?? null,
      };
      if (health && !health.ok) {
        throw new ControlError("SYNC_FAILED", `Sync failed: ${health.lastError}`, { status: 502, retryable: true, detail: { ...detail, ok: false } });
      }
      return { ok: true, ...detail };
    }
    if (layer.live === true) {
      // The live team layer: withGitSync's sync() lands any queued (offline)
      // commits — decisions committed while the remote was unreachable
      // included — then force-refreshes the tree. The re-index that follows
      // is what makes a teammate's pushed change visible.
      const source = sources.find((candidate) => candidate.name === name);
      if (!source || typeof source.sync !== "function") throw new ControlError("SYNC_UNSUPPORTED", `"${name}" does not support Sync`, { status: 400 });
      const lastSynced = await source.sync();
      invalidate(name);
      return { ok: true, synced: name, lastSynced };
    }
    if (!layer.origin) throw new ControlError("SYNC_UNSUPPORTED", `"${name}" is not a git-backed source`, { status: 400 });
    const { url, slug } = normalizeRepo(layer.origin);
    await gitCloneOrPull(url, path.join(CACHE_DIR, slug), layer.ref ?? null);
    reload();
    return { ok: true, synced: name };
  }

  // ---- config-only reads ------------------------------------------------------
  //
  // Nothing below opens an adapter. Reads are quarantined like the service's:
  // a malformed layer comes back as a row with its error, never as a failure
  // of the whole listing.

  function sourceRecord(layer, rank) {
    const kind = layer.source ?? "okf-local";
    const record = { name: layer.name, kind, level: manifestLevel(layer), rank };
    if (typeof layer.path === "string") {
      record.path = layer.path;
      record.resolvedPath = path.resolve(MANIFEST_DIR, layer.path);
    }
    for (const key of ["repo", "ref", "paths", "apiBase", "command", "args", "origin", "cache", "git", "auth"]) {
      if (layer[key] !== undefined && layer[key] !== null) record[key] = structuredClone(layer[key]);
    }
    if (layer.live === true) record.live = true;
    const clone = cloneDirOf(layer);
    if (clone) record.clone = { dir: clone, exists: fs.existsSync(clone) };
    return record;
  }

  // What a pending source still needs on this machine: every field settings
  // sync scrubbed, plus the one field its kind cannot run without.
  function pendingRecord(entry) {
    const kind = typeof entry?.source === "string" ? entry.source : "okf-local";
    const record = { name: entry.name, kind, level: manifestLevel(entry), missing: missingFields(entry) };
    for (const key of ["repo", "ref", "origin"]) {
      if (typeof entry[key] === "string") record[key] = entry[key];
    }
    return record;
  }

  function readForListing(profileId) {
    let read;
    try {
      read = readContextManifestQuarantined(MANIFEST, { allowMissing: false });
    } catch (err) {
      if (/^ContextCake manifest does not exist/.test(err.message)) throw err;
      throw new ControlError("MANIFEST_INVALID", err.message, { status: 422 });
    }
    const layers = getManifestProfileLayers(read.manifest, profileId);
    const key = quarantineProfileKey(read.manifest, profileId);
    return { ...read, layers, broken: read.quarantined.filter((entry) => entry.profileId === key) };
  }

  function listSources({ profileId = null } = {}) {
    const { manifest, layers, broken } = readForListing(profileId);
    const ordered = cascadeOrder(layers);
    return {
      sources: ordered.map((layer, index) => sourceRecord(layer, index + 1)),
      quarantined: broken.map(({ name, kind, level, error }) => ({ name, kind, level, error })),
      pending: (profileContainer(manifest, profileId).pendingSources ?? []).map(pendingRecord),
    };
  }

  function listPendingSources({ profileId = null } = {}) {
    return listSources({ profileId }).pending;
  }

  /**
   * Turn a pending source into a runnable layer by supplying what this
   * machine has to provide: `path`, `command` + `args`, `auth` (tokenEnv, when
   * the adapter accepts it), `level`. Every other field the entry carries
   * (cache, git, live, ref) is kept. Nothing is activated implicitly: the
   * caller names the source, the probes the add path runs still run, and an
   * MCP command still needs `trusted: true`.
   */
  async function configurePendingSource(name, supplied = {}, { profileId = null, expectRevision = null } = {}) {
    const precondition = precheckRevision(MANIFEST, expectRevision);
    const { manifest: current } = readForListing(profileId);
    const entry = (profileContainer(current, profileId).pendingSources ?? []).find((candidate) => candidate?.name === name);
    if (!entry) throw new ControlError("PENDING_NOT_FOUND", `No pending source named "${name}"`, { status: 404 });
    const layer = structuredClone(entry);
    const kind = layer.source ?? "okf-local";
    if (supplied.path !== undefined) {
      const given = expandHome(String(supplied.path).trim());
      if (!given) throw new ControlError("PATH_REQUIRED", "Give this source a folder path", { status: 400 });
      layer.path = given;
    }
    if (supplied.command !== undefined) {
      layer.command = String(supplied.command);
      // A new command replaces the whole invocation: arguments nobody
      // supplied are none, not the scrubbed ones.
      if (supplied.args === undefined) delete layer.args;
    }
    if (supplied.args !== undefined) layer.args = supplied.args.map(String);
    if (supplied.auth !== undefined) {
      if (!acceptTokenEnv || !isTokenEnvAuth(supplied.auth)) {
        throw new ControlError("REST_AUTH_REJECTED", "Only an environment variable reference ({tokenEnv}) can be supplied here.", { status: 400 });
      }
      layer.auth = { tokenEnv: supplied.auth.tokenEnv };
    }
    if (supplied.level !== undefined) {
      const level = parseLevel(supplied.level);
      if (level === null) throw new ControlError("LEVEL_INVALID", "level must be an integer", { status: 400 });
      layer.level = level;
    } else if (manifestLevel(layer) === null) {
      layer.level = 1;
    }
    const missing = missingFields(layer);
    if (missing.length) {
      throw new ControlError("PENDING_INCOMPLETE", `"${name}" still needs: ${missing.map((entry) => entry.field).join(", ")}`, { status: 400, detail: { missing } });
    }
    // Validate the result as the strict write will, before anything is probed.
    const candidate = structuredClone(current);
    getManifestProfileLayers(candidate, profileId).push(structuredClone(layer));
    removePendingSource(profileContainer(candidate, profileId), name);
    try {
      validateContextManifest(candidate);
    } catch (err) {
      throw new ControlError("PENDING_INVALID", `"${name}" cannot run as configured: ${err.message}`, { status: 400 });
    }

    let folder = null;
    if (kind === "okf-local" || kind === "files") {
      folder = await probeFolder(path.resolve(MANIFEST_DIR, layer.path), kind === "files" ? FILES_EXTENSIONS : [".md"]);
    } else if (kind === "mcp") {
      if (supplied.trusted !== true) {
        throw new ControlError("MCP_TRUST_REQUIRED", "Confirm that this MCP command came from a trusted source", { status: 400 });
      }
      const probeArgs = (layer.args ?? []).map((a) => (a.startsWith("./") || a.startsWith("../") ? path.resolve(MANIFEST_DIR, a) : a));
      await probeMcp({ name, level: layer.level, command: layer.command, args: probeArgs });
    } else if (kind === "github" && !layer.apiBase) {
      // A keychain alias cannot be resolved here; only probe what can be.
      const token = isTokenEnvAuth(layer.auth) ? (env[layer.auth.tokenEnv] || null) : null;
      if (layer.auth === undefined || token) await probeGithubRest(layer.repo, token);
    }

    try {
      mutateContextManifest(MANIFEST, (manifest) => {
        const layers = getManifestProfileLayers(manifest, profileId);
        const container = profileContainer(manifest, profileId);
        if (!(container.pendingSources ?? []).some((pending) => pending?.name === name)) {
          throw new ControlError("PENDING_NOT_FOUND", `No pending source named "${name}"`, { status: 404 });
        }
        if (layers.some((existing) => existing.name === name)) throw new ControlError("SOURCE_EXISTS", `A source named "${name}" already exists`, { status: 409 });
        layers.push(layer);
        removePendingSource(container, name);
      }, { allowMissing: false, allowTransitional: true, precondition });
    } catch (err) {
      if (err instanceof ControlError || err.status || isLockOrProfileError(err)) throw err;
      throw new ControlError("MANIFEST_INVALID", `Nothing was configured: the manifest is invalid, and saving would rewrite it around the problem. Remove the invalid source first — ${err.message}`, { status: 409 });
    }
    return {
      ok: true,
      configured: name,
      kind,
      level: layer.level,
      ...(folder ? { hasDocuments: folder.found, scanComplete: folder.complete } : {}),
    };
  }

  // ---- managed clones -----------------------------------------------------------

  // Every directory the manifest could still need, read from the raw file so
  // a quarantined layer and a pending source keep their clones too: any
  // string `path` anywhere, and the clone directory any `origin` maps to.
  // Conservative on purpose; a clone kept too long costs disk, one deleted
  // too early costs data.
  function referencedPaths() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw new ControlError("MANIFEST_INVALID", `Nothing was pruned: the manifest could not be read, so no clone can be proven unused — ${err.message}`, { status: 422 });
    }
    const out = [];
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const child of node) visit(child); return; }
      if (typeof node.path === "string") out.push(path.resolve(MANIFEST_DIR, expandHome(node.path)));
      if (typeof node.origin === "string") {
        try { out.push(path.join(CACHE_DIR, normalizeRepo(node.origin).slug)); } catch { /* not a git origin */ }
      }
      for (const child of Object.values(node)) visit(child);
    };
    visit(raw);
    return out;
  }

  function isReferenced(dir, paths) {
    return paths.some((candidate) => candidate === dir || candidate.startsWith(dir + path.sep) || dir.startsWith(candidate + path.sep));
  }

  // "clean", or why a clone must be kept. Anything git cannot answer counts
  // as a reason to keep it.
  async function cloneState(dir) {
    if (!fs.existsSync(path.join(dir, ".git"))) return "unreadable";
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    const git = (args) => execFileP("git", ["-C", dir, ...args], { timeout: 30_000, env });
    try {
      if ((await git(["status", "--porcelain"])).stdout.trim()) return "dirty";
      if ((await git(["stash", "list"])).stdout.trim()) return "dirty";
      // Commits reachable from HEAD or a local branch that no remote-tracking
      // ref or tag has: work that exists only here.
      const ahead = await git(["rev-list", "--count", "HEAD", "--branches", "--not", "--remotes", "--tags"]);
      if (Number(ahead.stdout.trim()) > 0) return "unpushed";
      return "clean";
    } catch {
      return "unreadable";
    }
  }

  // A staging directory younger than this may belong to an add still cloning.
  const STAGING_STALE_MS = 60 * 60 * 1000;

  async function surveyClones() {
    const paths = referencedPaths();
    const removable = [];
    const kept = [];
    const list = (dir) => {
      try { return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { return []; }
    };
    for (const entry of list(CACHE_DIR)) {
      if (entry.name.startsWith(".")) continue;
      const dir = path.join(CACHE_DIR, entry.name);
      if (isReferenced(dir, paths)) { kept.push({ dir, reason: "referenced" }); continue; }
      const state = await cloneState(dir);
      if (state === "clean") removable.push({ dir });
      else kept.push({ dir, reason: state });
    }
    // A staged clone was never a source: nobody has edited it. Old ones are
    // what a crashed add left behind.
    for (const entry of list(STAGING_DIR)) {
      const dir = path.join(STAGING_DIR, entry.name);
      let age = 0;
      try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch { continue; }
      if (age >= STAGING_STALE_MS) removable.push({ dir, staging: true });
    }
    return { removable, kept };
  }

  /**
   * Delete managed clones no source needs (§5.12). Without `confirm` it only
   * reports. A referenced clone is never removed, and neither is one with
   * uncommitted changes, a stash, commits no remote has, or a state git
   * cannot report. Both checks run again under the manifest lock right
   * before each delete.
   */
  async function pruneClones({ confirm = false } = {}) {
    const survey = await surveyClones();
    if (!confirm) return { cacheDir: CACHE_DIR, ...survey, removed: [], confirmed: false };
    return withManifestLockAsync(MANIFEST, async () => {
      const paths = referencedPaths();
      const kept = [...survey.kept];
      const removed = [];
      for (const candidate of survey.removable) {
        if (!candidate.staging) {
          if (isReferenced(candidate.dir, paths)) { kept.push({ dir: candidate.dir, reason: "referenced" }); continue; }
          const state = await cloneState(candidate.dir);
          if (state !== "clean") { kept.push({ dir: candidate.dir, reason: state }); continue; }
        }
        fs.rmSync(candidate.dir, { recursive: true, force: true });
        removed.push(candidate);
      }
      return { cacheDir: CACHE_DIR, removable: [], kept, removed, confirmed: true };
    });
  }

  return {
    addSource,
    removeSources,
    patchSource,
    reorderSources,
    gitCloneOrPull,
    syncSource,
    listSources,
    listPendingSources,
    configurePendingSource,
    pruneClones,
    cacheDir: CACHE_DIR,
  };
}

// Fields a source cannot run without on this machine: scrubbed values, and
// the one field its kind needs.
function missingFields(entry) {
  const kind = typeof entry?.source === "string" ? entry.source : "okf-local";
  const missing = [];
  for (const [field, value] of Object.entries(entry ?? {})) {
    if (isScrubMarker(value)) missing.push({ field, reason: value.__scrubbed });
  }
  const required = kind === "mcp" ? "command" : kind === "github" ? "repo" : (kind === "okf-local" || kind === "files") ? "path" : null;
  if (required && entry?.[required] === undefined) missing.push({ field: required, reason: "absent" });
  return missing;
}

/**
 * One selected-profile session for an operational command (§5.4): build the
 * adapters for that profile's layers (or just `names`), hand them to `fn`,
 * and close every source, and so every MCP child, in `finally`, whatever
 * `fn` did. A layer that fails to build becomes an entry with `error`, and a
 * quarantined layer an entry with `quarantined: true`, so a test can report
 * them instead of failing outright.
 */
export async function withSourceSession({ manifestPath, profileId = null, names = null }, fn) {
  const resolved = path.resolve(manifestPath);
  const manifestDir = path.dirname(resolved);
  let read;
  try {
    read = readContextManifestQuarantined(resolved, { allowMissing: false });
  } catch (err) {
    if (/^ContextCake manifest does not exist/.test(err.message)) throw err;
    throw new ControlError("MANIFEST_INVALID", err.message, { status: 422 });
  }
  const { manifest, quarantined } = read;
  const layers = getManifestProfileLayers(manifest, profileId);
  const key = quarantineProfileKey(manifest, profileId);
  let broken = quarantined.filter((entry) => entry.profileId === key);
  let selected = layers;
  if (names?.length) {
    const unknown = names.filter((name) => !layers.some((layer) => layer.name === name) && !broken.some((entry) => entry.name === name));
    if (unknown.length) throw new ControlError("SOURCE_NOT_FOUND", `No source named ${unknown.map((name) => `"${name}"`).join(", ")}`, { status: 404, detail: { unknown } });
    selected = layers.filter((layer) => names.includes(layer.name));
    broken = broken.filter((entry) => names.includes(entry.name));
  }
  const runtime = { ...(manifest.settings ? { settings: manifest.settings } : {}) };
  const entries = [];
  try {
    for (const layer of selected) {
      try {
        const [source] = buildSources({ ...runtime, layers: [layer] }, manifestDir, { profileId: profileId ?? "default" });
        entries.push({ layer, source });
      } catch (error) {
        entries.push({ layer, source: null, error: error.message });
      }
    }
    for (const entry of broken) entries.push({ layer: { name: entry.name, level: entry.level, source: entry.kind }, source: null, error: entry.error, quarantined: true });
    return await fn({ manifest, layers: selected, entries });
  } finally {
    await Promise.allSettled(entries.map(({ source }) => Promise.resolve().then(() => source?.close?.())));
  }
}

/**
 * Read every source in a session once and report what came back: concept
 * count, health, and why a source could not be read. `coverage` follows the
 * envelope's shape; it is incomplete when any source failed.
 */
export async function testSources(entries, { timeoutMs = 30_000 } = {}) {
  const results = await Promise.all(entries.map(async (entry) => {
    const kind = entry.layer.source ?? "okf-local";
    const base = { name: entry.layer.name, kind, level: manifestLevel(entry.layer) };
    if (!entry.source) return { ...base, ok: false, concepts: 0, error: entry.error, ...(entry.quarantined ? { quarantined: true } : {}) };
    const started = Date.now();
    const controller = new AbortController();
    const notes = { skipped: [], unreadable: [] };
    try {
      const ids = await withDeadline(
        entry.source.listConceptIds({ signal: controller.signal, notes }),
        timeoutMs,
        `timed out after ${timeoutMs}ms`,
        () => controller.abort(new Error("source test timed out")),
      );
      const health = typeof entry.source.health === "function" ? entry.source.health() : null;
      const ok = !health || health.ok !== false;
      return {
        ...base,
        ok,
        concepts: ids.length,
        durationMs: Date.now() - started,
        ...(ok ? {} : { error: health.lastError }),
        ...(notes.truncated ? { truncated: notes.truncated } : {}),
        ...(notes.unreadable.length ? { unreadable: notes.unreadable.length } : {}),
      };
    } catch (error) {
      return { ...base, ok: false, concepts: 0, durationMs: Date.now() - started, error: error.message };
    }
  }));
  const degraded = results.filter((result) => !result.ok).map((result) => ({ source: result.name, reason: result.error ?? "unreadable" }));
  return { sources: results, coverage: { complete: degraded.length === 0, degraded } };
}
