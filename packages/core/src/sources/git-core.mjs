// Locked git mutation coordinator for live layers. Every git operation
// against a live-layer working tree goes through this module — pull, commit,
// rebase, push — serialized per repo via an advisory directory lease so concurrent
// harness processes (several MCP servers over one clone) never interleave
// mutations. Spawns the git CLI; no npm dependency (same precedent as the
// mcp source spawning foreign servers).

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withManifestLockAsync } from "../manifest.mjs";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 90000; // bound a hung git op; a live owner never expires

// Never let git block on an interactive credential/askpass prompt (would hang
// the MCP server); fail fast instead. Timeout bounds a wedged network op.
const GIT_OPTS = {
  timeout: GIT_TIMEOUT_MS,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  maxBuffer: 16 * 1024 * 1024,
};

// Remote URLs (which may embed credentials) never surface to agents or logs.
// Same result as .replace(/[a-z][a-z0-9+.-]*:\/\/\S+|git@\S+/gi, "<remote>"), in
// one pass: that regex rescanned a run of scheme characters from every letter in
// it, and git's stderr carries whatever a remote chooses to print.
export function scrub(text) {
  const value = String(text ?? "");
  let out = "";
  let copied = 0;
  let i = 0;
  while (i < value.length) {
    if (!/[a-z0-9+.-]/i.test(value[i])) {
      i += 1;
      continue;
    }
    // Every match starts inside a run of scheme characters, and every start in
    // one run reaches the same end: "://" or "@" has to come right there.
    let end = i;
    while (end < value.length && /[a-z0-9+.-]/i.test(value[end])) end += 1;
    let start = -1;
    if (value.startsWith("://", end) && end + 3 < value.length && /\S/.test(value[end + 3])) {
      // The leftmost letter in the run; a run of digits and punctuation has none.
      for (let at = i; at < end; at += 1) {
        if (/[a-z]/i.test(value[at])) { start = at; break; }
      }
    } else if (value[end] === "@" && end - i >= 3 && value.slice(end - 3, end).toLowerCase() === "git"
      && end + 1 < value.length && /\S/.test(value[end + 1])) {
      start = end - 3;
    }
    if (start === -1) {
      i = end;
      continue;
    }
    let stop = end;
    while (stop < value.length && /\S/.test(value[stop])) stop += 1;
    out += `${value.slice(copied, start)}<remote>`;
    copied = stop;
    i = stop;
  }
  return out + value.slice(copied);
}

export async function runGit(root, args, { allowFailure = false, input, trim = true } = {}) {
  try {
    const pending = execFileAsync("git", args, { cwd: root, ...GIT_OPTS });
    if (input !== undefined) {
      pending.child.stdin.on("error", () => {}); // git may refuse before reading
      pending.child.stdin.end(input);
    }
    const { stdout, stderr } = await pending;
    return { ok: true, stdout: trim ? stdout.trim() : stdout, stderr: stderr.trim() };
  } catch (error) {
    if (allowFailure) {
      // `||`, not `??`: a maxBuffer/timeout kill leaves stderr an empty string,
      // and a caller that surfaces it would report a blank reason.
      return { ok: false, stdout: scrub(error.stdout ?? ""), stderr: scrub(error.stderr || error.message) };
    }
    const wrapped = new Error(`git ${args[0]} failed: ${scrub(error.stderr || error.message)}`);
    wrapped.code = "GitError";
    throw wrapped;
  }
}

// ---- advisory repo lock -----------------------------------------------------

// The shared directory-claim lease owns the existing .contextcake.lock path.
// Reusing its generation-safe recovery avoids a second stale-rename protocol.
// The older regular-file protocol requires coordinated upgrade/manual cleanup.
export async function withRepoLock(root, op, fn, { skipOnBusy = false, lockRetryMs = 2000, lockRetries = 3 } = {}) {
  let entered = false;
  try {
    return await withManifestLockAsync(path.join(root, ".contextcake"), () => {
      entered = true;
      return fn();
    }, { timeoutMs: skipOnBusy ? 0 : Math.max(0, (lockRetries - 1) * lockRetryMs), createParent: false, reclaimDeadOwners: false });
  } catch (error) {
    // A mutation's own error must never be mistaken for acquisition failure.
    if (entered || !/^Timed out acquiring the ContextCake manifest lock/.test(error.message)) throw error;
    const legacy = error.message.includes("manual cleanup");
    if (skipOnBusy && !legacy) return { skipped: true };
    const busy = new Error(legacy ? error.message.replace("manifest lock", "repository lock") : `Repo lock busy for ${op} (held by another ContextCake process)`);
    busy.code = "LockBusy";
    throw busy;
  }
}

// ---- mutations ----------------------------------------------------------------

async function hasIdentity(root) {
  const name = await runGit(root, ["config", "user.name"], { allowFailure: true });
  const email = await runGit(root, ["config", "user.email"], { allowFailure: true });
  return name.ok && name.stdout !== "" && email.ok && email.stdout !== "";
}

function identityArgs(author) {
  const slug = String(author ?? "contextcake").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "contextcake";
  return ["-c", `user.name=${author ?? "ContextCake"}`, "-c", `user.email=${slug}@users.noreply.contextcake.local`];
}

// Stages ONLY the named paths (never -A) and commits. Identity falls back to a
// per-invocation -c pair — never writes config.
export async function commitPaths(root, paths, message, { author = null, lockRetryMs, lockRetries } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("commitPaths requires at least one path");
  return withRepoLock(root, "commit", () => commitPathsUnlocked(root, paths, message, author), { lockRetryMs, lockRetries });
}

// Acquires the repo lock before a caller mutates the working tree, then commits
// only the named paths. If the mutation OR add/commit fails, rollback runs
// while the same lock is still held so the operation can remain safely
// retryable — a mutation that threw halfway (one of several files renamed) is
// restored under the lock, never by a compensating step that runs after the
// lock is gone. Callers write `rollback` to be safe against a mutation that
// did nothing yet (no-op when nothing was staged or placed).
//
// `skipIfClean`: when the mutation left every named path byte-identical to
// the index (a decision that writes a layer's own winning value back to it,
// a recovery that restored files git never saw change), answer
// `{ committed: false, clean: true }` instead of letting `git commit` refuse
// with "nothing to commit" — which would otherwise roll a correct write back.
export async function commitPathsWithMutation(root, paths, message, {
  mutate,
  rollback,
  author = null,
  skipIfClean = false,
  lockRetryMs,
  lockRetries,
} = {}) {
  if (typeof paths !== "function" && (!Array.isArray(paths) || paths.length === 0)) throw new Error("commitPathsWithMutation requires at least one path");
  if (typeof mutate !== "function" || typeof rollback !== "function") {
    throw new Error("commitPathsWithMutation requires mutate and rollback callbacks");
  }
  return withRepoLock(root, "commit", async () => {
    let selectedPaths;
    let index = null;
    try {
      await mutate();
      // Editors learn their exact file extensions while preparing under this
      // lock. A callback names those actual targets without a racy pre-read.
      selectedPaths = typeof paths === "function" ? paths() : paths;
      if (!Array.isArray(selectedPaths)) throw new Error("mutation paths must be an array");
      if (selectedPaths.length === 0 || (skipIfClean && await pathsClean(root, selectedPaths))) return { committed: false, clean: true };
      index = await snapshotIndex(root, selectedPaths);
      return await commitPathsUnlocked(root, selectedPaths, message, author);
    } catch (error) {
      const failures = [];
      try {
        await rollback(error);
      } catch (rollbackError) { failures.push(rollbackError.message); }
      // git add may have succeeded before commit failed. Restore exactly the
      // named paths' old index entries too, including pre-existing staging;
      // never reset the whole index or discard an unrelated staged edit.
      try { if (index) await restoreIndex(root, selectedPaths, index); }
      catch (indexError) { failures.push(`index: ${indexError.message}`); }
      if (failures.length) {
        const combined = new Error(`${error.message}; rollback failed: ${failures.join("; ")}`);
        combined.code = "RollbackFailed";
        throw combined;
      }
      throw error;
    }
  }, { lockRetryMs, lockRetries });
}

// The named paths are file names, not patterns: a concept id with `*`, `?`,
// or `[` in it (`db[1].md`) would otherwise be a glob that sweeps a dirty
// sibling (`db1.md`) into the pathspec commit. Every pathspec-taking call
// below carries this so callers never have to escape.
const LITERAL = "--literal-pathspecs";

async function snapshotIndex(root, paths) {
  const entries = await runGit(root, [LITERAL, "ls-files", "--stage", "-z", "--", ...paths], { trim: false });
  const flags = await runGit(root, [LITERAL, "ls-files", "-v", "-z", "--", ...paths], { trim: false });
  const visible = await runGit(root, [LITERAL, "diff", "--cached", "--name-only", "-z", "--ita-visible-in-index", "--", ...paths], { trim: false });
  const invisible = await runGit(root, [LITERAL, "diff", "--cached", "--name-only", "-z", "--ita-invisible-in-index", "--", ...paths], { trim: false });
  const real = new Set(invisible.stdout.split("\0"));
  const intent = visible.stdout.split("\0").filter((name) => name && !real.has(name));
  return { entries: entries.stdout, flags: flags.stdout, intent };
}

async function restoreIndex(root, paths, saved) {
  const current = await runGit(root, [LITERAL, "ls-files", "--stage", "-z", "--", ...paths], { trim: false });
  const names = new Set(current.stdout.split("\0").filter(Boolean).map((row) => row.slice(row.indexOf("\t") + 1)));
  // NUL framing preserves tabs/newlines in filenames; index-info also retains
  // merge stages, executable modes, and staged blobs that differ from HEAD.
  const zero = current.stdout.match(/^\d+ ([0-9a-f]+) /)?.[1].replace(/./g, "0");
  const remove = [...names].map((name) => `0 ${zero}\t${name}\0`).join("");
  const entries = saved.entries.split("\0").filter((row) => row && !saved.intent.includes(row.slice(row.indexOf("\t") + 1)));
  await runGit(root, ["update-index", "-z", "--index-info"], { input: remove + entries.map((row) => `${row}\0`).join("") });
  if (saved.intent.length) await runGit(root, [LITERAL, "add", "--intent-to-add", "--", ...saved.intent]);
  const flags = saved.flags.split("\0").filter(Boolean);
  const assumed = flags.filter((row) => row[0] === row[0].toLowerCase()).map((row) => row.slice(2));
  const skipped = flags.filter((row) => row[0].toUpperCase() === "S").map((row) => row.slice(2));
  if (assumed.length) await runGit(root, ["update-index", "--assume-unchanged", "--", ...assumed]);
  if (skipped.length) await runGit(root, ["update-index", "--skip-worktree", "--", ...skipped]);
}

// True when none of the named paths differs from HEAD/index — modified,
// staged, or untracked all count as dirty. Untracked files are listed
// individually so a new file inside a listed directory is seen.
async function pathsClean(root, paths) {
  const status = await runGit(root, [LITERAL, "status", "--porcelain", "--untracked-files=all", "--", ...paths]);
  return status.stdout === "";
}

async function commitPathsUnlocked(root, paths, message, author) {
  await runGit(root, [LITERAL, "add", "--", ...paths]);
  const ident = (await hasIdentity(root)) ? [] : identityArgs(author);
  // Pathspec commit: commit ONLY these paths, so a pre-existing staged change
  // (e.g. a prior failed op) can't be swept into this commit's message.
  await runGit(root, [LITERAL, ...ident, "commit", "-m", message, "--", ...paths]);
  return { committed: true };
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
