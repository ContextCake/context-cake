// Locked git mutation coordinator for live layers. Every git operation
// against a live-layer working tree goes through this module — pull, commit,
// rebase, push — serialized per repo via an advisory lockfile so concurrent
// harness processes (several MCP servers over one clone) never interleave
// mutations. Spawns the git CLI; no npm dependency (same precedent as the
// mcp source spawning foreign servers).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LOCK_NAME = ".contextcake.lock"; // dotfile: invisible to walkMarkdown
const GIT_TIMEOUT_MS = 90000; // bound a hung git op (must stay < LOCK_STALE_MS)
// A locked mutation can make several bounded git calls (push → pull/rebase →
// retry), so the stale window must cover the whole workflow, not one call.
const LOCK_STALE_MS = GIT_TIMEOUT_MS * 6;

// Never let git block on an interactive credential/askpass prompt (would hang
// the MCP server); fail fast instead. Timeout bounds a wedged network op.
const GIT_OPTS = {
  timeout: GIT_TIMEOUT_MS,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  maxBuffer: 16 * 1024 * 1024,
};

// Remote URLs (which may embed credentials) never surface to agents or logs.
function scrub(text) {
  return String(text ?? "").replace(/[a-z][a-z0-9+.-]*:\/\/\S+|git@\S+/gi, "<remote>");
}

export async function runGit(root, args, { allowFailure = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd: root, ...GIT_OPTS });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    if (allowFailure) {
      return { ok: false, stdout: scrub(error.stdout ?? ""), stderr: scrub(error.stderr ?? error.message) };
    }
    const wrapped = new Error(`git ${args[0]} failed: ${scrub(error.stderr || error.message)}`);
    wrapped.code = "GitError";
    throw wrapped;
  }
}

// ---- advisory repo lock -----------------------------------------------------

function lockPath(root) {
  return path.join(root, LOCK_NAME);
}

function readLock(root) {
  try {
    return JSON.parse(fs.readFileSync(lockPath(root), "utf8"));
  } catch {
    return null;
  }
}

function lockIsStale(lock) {
  if (!lock || typeof lock.ts !== "number") return true; // corrupt/legacy → stealable
  const age = Date.now() - lock.ts;
  // Stale if older than the window, OR dated far in the future (clock skew or a
  // .contextcake.lock that got committed and checked out) — otherwise a future
  // ts would make the lock un-stealable forever.
  return age > LOCK_STALE_MS || age < -LOCK_STALE_MS;
}

function tryAcquire(root, op) {
  const token = crypto.randomUUID();
  const payload = JSON.stringify({ pid: process.pid, ts: Date.now(), op, token });
  try {
    fs.writeFileSync(lockPath(root), payload, { flag: "wx" });
    return token;
  } catch {
    const existing = readLock(root);
    if (!lockIsStale(existing)) return null;
    // Atomic steal: renaming the stale lock away is the compare-and-swap —
    // only one racer can rename a given inode (the rest get ENOENT), so two
    // processes can't both steal and double-acquire (the old rm+write could).
    const parked = `${lockPath(root)}.${process.pid}.${Date.now()}.stale`;
    try {
      fs.renameSync(lockPath(root), parked);
    } catch {
      return null; // lost the steal race, or the lock changed under us
    }
    fs.rmSync(parked, { force: true });
    try {
      fs.writeFileSync(lockPath(root), payload, { flag: "wx" });
      return token;
    } catch {
      return null; // a fresh holder grabbed the freed lock; yield
    }
  }
}

function release(root, token) {
  try {
    // A stale holder may finish after another process has replaced its lock.
    // Never delete the replacement: only the process that owns this token may
    // release it.
    if (readLock(root)?.token !== token) return;
    fs.rmSync(lockPath(root), { force: true });
  } catch {
    // releasing a lock must never throw past the operation it protected
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Writers retry then throw LockBusy; readers pass skipOnBusy to serve stale.
export async function withRepoLock(root, op, fn, { skipOnBusy = false, lockRetryMs = 2000, lockRetries = 3 } = {}) {
  let attempts = 0;
  let token = tryAcquire(root, op);
  while (!token) {
    if (skipOnBusy) return { skipped: true };
    attempts += 1;
    if (attempts >= lockRetries) {
      const error = new Error(`Repo lock busy for ${op} (held by another ContextCake process)`);
      error.code = "LockBusy";
      throw error;
    }
    await sleep(lockRetryMs);
    token = tryAcquire(root, op);
  }
  try {
    return await fn();
  } finally {
    release(root, token);
  }
}

// ---- mutations ----------------------------------------------------------------

async function hasIdentity(root) {
  const name = await runGit(root, ["config", "user.name"], { allowFailure: true });
  const email = await runGit(root, ["config", "user.email"], { allowFailure: true });
  return name.ok && name.stdout !== "" && email.ok && email.stdout !== "";
}

function identityArgs(author) {
  const slug = String(author ?? "contextcake").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "contextcake";
  return ["-c", `user.name=${author ?? "ContextCake"}`, "-c", `user.email=${slug}@users.noreply.contextcake.local`];
}

// Stages ONLY the named paths (never -A) and commits. Identity falls back to a
// per-invocation -c pair — never writes config.
export async function commitPaths(root, paths, message, { author = null, lockRetryMs, lockRetries } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("commitPaths requires at least one path");
  return withRepoLock(root, "commit", async () => {
    await runGit(root, ["add", "--", ...paths]);
    const ident = (await hasIdentity(root)) ? [] : identityArgs(author);
    // Pathspec commit: commit ONLY these paths, so a pre-existing staged change
    // (e.g. a prior failed op) can't be swept into this commit's message.
    await runGit(root, [...ident, "commit", "-m", message, "--", ...paths]);
    return { committed: true };
  }, { lockRetryMs, lockRetries });
}

async function pushOnce(root) {
  const result = await runGit(root, ["push", "--quiet"], { allowFailure: true });
  if (result.ok) return { pushed: true };
  if (/no upstream|set-upstream/i.test(result.stderr)) {
    const up = await runGit(root, ["push", "--quiet", "-u", "origin", "HEAD"], { allowFailure: true });
    if (up.ok) return { pushed: true };
    return { pushed: false, reason: up.stderr };
  }
  return { pushed: false, reason: result.stderr };
}

async function pullRebaseUnlocked(root) {
  const result = await runGit(root, ["pull", "--rebase", "--quiet"], { allowFailure: true });
  if (!result.ok) {
    await runGit(root, ["rebase", "--abort"], { allowFailure: true });
    return false;
  }
  return true;
}

// Push with recovery: missing upstream → set it; divergence → pull --rebase and
// retry once; still failing → the commit stays local and is reported queued.
export async function push(root, { lockRetryMs, lockRetries } = {}) {
  return withRepoLock(root, "push", async () => {
    const remotes = await runGit(root, ["remote"], { allowFailure: true });
    if (!remotes.ok || remotes.stdout === "") return { pushed: false, queued: false, localOnly: true };

    const first = await pushOnce(root);
    if (first.pushed) return { pushed: true };

    if (await pullRebaseUnlocked(root)) {
      const second = await pushOnce(root);
      if (second.pushed) return { pushed: true };
    }
    console.error(`contextcake: push queued for ${path.basename(root)} (will retry on next capture or sync)`);
    return { pushed: false, queued: true };
  }, { lockRetryMs, lockRetries });
}

// Lands any locally-committed-but-unpushed work (the offline queue).
export async function retryQueued(root, opts = {}) {
  const upstream = await runGit(root, ["rev-parse", "--abbrev-ref", "@{upstream}"], { allowFailure: true });
  if (upstream.ok) {
    const ahead = await runGit(root, ["log", "--oneline", "@{upstream}.."], { allowFailure: true });
    if (ahead.ok && ahead.stdout === "") return { pushed: false, queued: false, upToDate: true };
  }
  return push(root, opts);
}

// TTL-agnostic pull (callers gate on TTL). Reader semantics: skip on lock
// contention and serve the current tree — staleness stays bounded by the TTL.
export async function pull(root) {
  return withRepoLock(root, "pull", async () => {
    const before = await runGit(root, ["rev-parse", "HEAD"], { allowFailure: true });
    const ff = await runGit(root, ["pull", "--ff-only", "--quiet"], { allowFailure: true });
    if (!ff.ok) {
      const rebased = await pullRebaseUnlocked(root);
      if (!rebased) {
        console.error(`contextcake: pull failed for ${path.basename(root)}; serving current tree`);
        return { changed: false };
      }
    }
    const after = await runGit(root, ["rev-parse", "HEAD"], { allowFailure: true });
    return { changed: before.ok && after.ok && before.stdout !== after.stdout };
  }, { skipOnBusy: true });
}
