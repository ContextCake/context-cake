// Source control operations — the shared validation and mutation behind the
// /api/sources CRUD and the CLI's `source` family
// (specs/contextcake-control-plane/design.md §1). The HTTP service and the
// CLI are parsing shims over these; neither carries its own copy of a probe,
// a mutation, or a refusal message.
//
// Credentials are a capability, not state: the adapter that owns tokens
// injects `gitCredentialsForUrl(url) => secrets[]`, the same one-way flow as
// buildSources' token map — these operations never read a keychain.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { probeDocs } from "../sources/okf-local.mjs";
import { FILES_EXTENSIONS } from "../sources/files.mjs";
import { createMcpSource } from "../sources/mcp.mjs";
import {
  classifyManifest,
  getManifestProfileLayers,
  mutateContextManifest,
  readContextManifest,
  repairContextManifest,
} from "../manifest.mjs";
import { ControlError } from "./errors.mjs";
import { withDeadline } from "./util.mjs";

const execFileP = promisify(execFile);

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
async function probeGithubRest(slug) {
  const base = process.env.CONTEXTCAKE_GITHUB_PROBE_BASE || "https://api.github.com";
  let res;
  try {
    res = await fetch(`${base}/repos/${slug}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "contextcake",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000), // mirrors the adapter's request timeout
    });
  } catch {
    return; // unreachable — fail open, the first index reports health honestly
  }
  if (res.status === 404 || res.status === 403) {
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

export function createSourceOperations({ manifestPath, gitCredentialsForUrl = () => [] }) {
  const MANIFEST = path.resolve(manifestPath);
  const MANIFEST_DIR = path.dirname(MANIFEST);
  // Git-backed sources clone next to the manifest that declares them.
  const CACHE_DIR = path.join(MANIFEST_DIR, ".cache", "repos");

  async function addSource(b) {
    const name = String(b.name ?? "").trim();
    if (!/^[a-zA-Z0-9 _-]{1,40}$/.test(name)) throw new ControlError("NAME_INVALID", "Name: letters/numbers/space/_/- (max 40)", { status: 400 });
    const initialManifest = readContextManifest(MANIFEST, { allowMissing: false });
    if (getManifestProfileLayers(initialManifest).some((l) => l.name === name)) throw new ControlError("SOURCE_EXISTS", `A source named "${name}" already exists`, { status: 409 });
    const level = Number.isFinite(+b.level) ? +b.level : 1;

    let layer;
    let folder = null;
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
      if (b.auth !== undefined || b.apiBase !== undefined) {
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
      await probeGithubRest(slug);
      layer = {
        name,
        level,
        source: "github",
        repo: slug,
        ...(b.ref ? { ref: String(b.ref) } : {}),
        ...(Array.isArray(b.paths) && b.paths.length ? { paths: b.paths } : {}),
        cache: { ttlSeconds: 900 },
      };
    } else if (b.kind === "github") {
      const { url, slug } = normalizeRepo(String(b.repo ?? ""));
      const dir = path.join(CACHE_DIR, slug);
      await gitCloneOrPull(url, dir, b.ref ? String(b.ref) : null);
      const sub = b.subdir ? String(b.subdir).replace(/^\/+|\/+$/g, "") : "";
      // The sub-directory must stay inside the clone — otherwise this field would
      // set a new sandbox root (layer.path) pointing anywhere on disk.
      let abs = dir;
      if (sub) {
        abs = path.resolve(dir, sub);
        if (abs !== dir && !abs.startsWith(dir + path.sep)) throw new ControlError("SUBDIR_ESCAPES", "Sub-directory escapes the repository", { status: 400 });
      }
      folder = await probeFolder(abs, [".md"]);
      layer = { name, level, path: path.relative(MANIFEST_DIR, abs), origin: url, ref: b.ref || null };
    } else {
      throw new ControlError("KIND_UNKNOWN", `Unknown source kind: ${b.kind}`, { status: 400 });
    }

    mutateContextManifest(MANIFEST, (manifest) => {
      const layers = getManifestProfileLayers(manifest);
      if (layers.some((candidate) => candidate.name === name)) throw new ControlError("SOURCE_EXISTS", `A source named "${name}" already exists`, { status: 409 });
      layers.push(layer);
      // A synced source whose machine-local path/command was scrubbed waits in
      // pendingSources. Configuring that source locally promotes it to a runnable
      // layer without leaving a duplicate metadata-only record behind.
      removePendingSource(defaultProfileContainer(manifest), name);
    }, { allowMissing: false, allowTransitional: true });
    return {
      ok: true,
      added: name,
      indexing: true, // counts arrive via /api/graph as the index lands
      ...(folder ? { hasDocuments: folder.found, scanComplete: folder.complete } : {}),
    };
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
  function removeSources(names) {
    const wanted = [...new Set(names.filter((name) => typeof name === "string" && name))];
    if (wanted.length === 0) throw new ControlError("NAME_REQUIRED", "Provide ?name=", { status: 400 });
    const removed = [];
    let survivors = [];
    let blocking = [];
    try {
      repairContextManifest(MANIFEST, ({ manifest, layers, quarantined }) => {
        const container = defaultProfileContainer(manifest);
        // Quarantined rows for the profile this service reads. A layer
        // quarantined out of some OTHER profile has no row here to have been
        // clicked, and removing it is not this route's business.
        const broken = quarantined.filter((entry) => entry.profileId === "default");
        // A set, because these become splices: two names resolving to one index
        // would take a second, innocent layer with them.
        const doomed = new Set();
        for (const name of wanted) {
          const pendingBefore = container.pendingSources?.length ?? 0;
          removePendingSource(container, name);
          const droppedPending = (container.pendingSources?.length ?? 0) !== pendingBefore;
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
      }, { allowTransitional: true });
    } catch (err) {
      if (err.status) throw err;
      if (blocking.length > 0) {
        const listed = blocking.map((entry) => `"${entry.name}" (${entry.error})`).join("; ");
        throw new ControlError("REMOVE_BLOCKED", `Nothing was removed: ${blocking.length} other source${blocking.length === 1 ? " is" : "s are"} also invalid, and the manifest cannot be saved while ${blocking.length === 1 ? "it remains" : "they remain"}. Remove ${blocking.length === 1 ? "it" : "them"} in the same request — ${listed}`, { status: 409 });
      }
      // A manifest broken in a way no single layer explains (two layers sharing
      // a name, a malformed profiles block) is not repairable from here, and an
      // internal error would read as "the app is broken" rather than "your file
      // is". Say which, and keep the engine's own message — it names the actual
      // defect.
      throw new ControlError("MANIFEST_UNREPAIRABLE", `Nothing was removed: the manifest is invalid in a way this app cannot repair. Edit ${MANIFEST} by hand — ${err.message}`, { status: 409 });
    }
    for (const layer of removed) cleanupCloneDir(layer, survivors);
    return { ok: true, removed: wanted[0], removedNames: wanted };
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
  function cleanupCloneDir(layer, survivors) {
    const dir = cloneDirOf(layer);
    if (!dir) return;
    const inUse = survivors.some((candidate) => {
      if (typeof candidate?.path !== "string") return false;
      const resolved = path.resolve(MANIFEST_DIR, candidate.path);
      return resolved === dir || resolved.startsWith(dir + path.sep);
    });
    if (inUse) return;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* orphan dir stays; the manifest entry is already gone */ }
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

  async function patchSource(b) {
    // A path change is validated before the manifest is touched, with the same
    // cheap probe the add path uses — folder-missing and not-a-folder fail the
    // request, size never does. The kind is re-checked inside the mutation
    // below; this read only decides which extensions the probe looks for.
    let nextPath;
    let probed = null;
    if (b.path !== undefined) {
      // Typed before it is coerced: String(["/etc"]) is "/etc", so an array
      // would otherwise walk straight through the trim and the probe.
      if (typeof b.path !== "string") throw new ControlError("PATH_REQUIRED", "Give this source a folder path", { status: 400 });
      const layer = getManifestProfileLayers(readContextManifest(MANIFEST, { allowMissing: false })).find((candidate) => candidate.name === b.name);
      if (!layer) throw new ControlError("SOURCE_NOT_FOUND", `No source named "${b.name}"`, { status: 404 });
      const refusal = pathPatchRefusal(layer);
      if (refusal) throw new ControlError("PATCH_REFUSED", refusal, { status: 400 });
      nextPath = expandHome(b.path.trim());
      if (!nextPath) throw new ControlError("PATH_REQUIRED", "Give this source a folder path", { status: 400 });
      const kind = layer.source ?? "okf-local";
      probed = await probeFolder(path.resolve(MANIFEST_DIR, nextPath), kind === "files" ? FILES_EXTENSIONS : [".md"]);
    }
    mutateContextManifest(MANIFEST, (manifest) => {
      const layers = getManifestProfileLayers(manifest);
      const layer = layers.find((candidate) => candidate.name === b.name);
      if (!layer) throw new ControlError("SOURCE_NOT_FOUND", `No source named "${b.name}"`, { status: 404 });
      if (nextPath !== undefined) {
        const refusal = pathPatchRefusal(layer);
        if (refusal) throw new ControlError("PATCH_REFUSED", refusal, { status: 400 });
        layer.path = nextPath;
      }
      if (b.level !== undefined && Number.isFinite(+b.level)) layer.level = +b.level;
      if (b.newName && b.newName !== b.name) {
        if (!/^[a-zA-Z0-9 _-]{1,40}$/.test(b.newName)) throw new ControlError("NAME_INVALID", "Invalid new name", { status: 400 });
        if (layers.some((candidate) => candidate.name === b.newName)) throw new ControlError("NAME_EXISTS", "Name already exists", { status: 409 });
        layer.name = b.newName;
      }
    }, { allowMissing: false, allowTransitional: true });
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

  return { addSource, removeSources, patchSource, gitCloneOrPull };
}
