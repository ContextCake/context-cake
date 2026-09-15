// git-core.commitPathsWithMutation: the mutation runs INSIDE the repo lock and
// inside the try, so a mutation that throws halfway is rolled back under that
// same lock — never by a compensating step after the lock is gone — and the
// error still propagates. Uses a real `git init` so the lock file, the status
// check, and the pathspec commit are the real ones.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitPathsWithMutation, scrub } from "../src/sources/git-core.mjs";

async function repo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-git-core-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(dir, "gitconfig"), GIT_CONFIG_SYSTEM: "/dev/null" };
  await fsp.writeFile(path.join(dir, "gitconfig"), "[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[init]\n\tdefaultBranch = main\n");
  const root = path.join(dir, "repo");
  await fsp.mkdir(root);
  execFileSync("git", ["init", "--quiet", root], { env });
  await fsp.writeFile(path.join(root, "a.md"), "# A\n\noriginal a\n");
  await fsp.writeFile(path.join(root, "b.md"), "# B\n\noriginal b\n");
  execFileSync("git", ["-C", root, "add", "-A"], { env });
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "seed"], { env });
  return { dir, root, env, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

test("a mutation that throws halfway is rolled back under the repo lock, litter is gone, and the error propagates", async () => {
  const { root, env, cleanup } = await repo();
  try {
    const a = path.join(root, "a.md");
    const b = path.join(root, "b.md");
    const staged = `${a}.contextcake-tx-0.new`;
    const backup = `${a}.contextcake-tx-0.bak`;
    const events = [];
    await assert.rejects(commitPathsWithMutation(root, ["a.md", "b.md"], "chore: two files", {
      mutate: async () => {
        // First file replaced (as a staged transaction would: backup, then
        // rename), then the second step fails.
        await fsp.copyFile(a, backup);
        await fsp.writeFile(staged, "# A\n\nnew a\n");
        await fsp.rename(staged, a);
        events.push("mutated-a");
        throw new Error("injected: second target failed");
      },
      rollback: async () => {
        // Rollback runs while this process still holds the repo lock.
        events.push(["rollback", fs.existsSync(path.join(root, ".contextcake.lock"))]);
        await fsp.copyFile(backup, a);
        await fsp.unlink(backup);
      },
    }), /injected: second target failed/);
    assert.deepEqual(events, ["mutated-a", ["rollback", true]], "rollback ran, under the lock, after the partial mutation");
    assert.equal(await fsp.readFile(a, "utf8"), "# A\n\noriginal a\n", "the partial change was restored");
    assert.equal(await fsp.readFile(b, "utf8"), "# B\n\noriginal b\n");
    assert.deepEqual((await fsp.readdir(root)).filter((name) => name.includes("contextcake")), [], "no lock, staged, or backup litter");
    assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain"], { env, encoding: "utf8" }), "", "the tree is clean");
    assert.equal(execFileSync("git", ["-C", root, "rev-list", "--count", "HEAD"], { env, encoding: "utf8" }).trim(), "1", "no commit was made");
    // A rollback that itself throws is reported as RollbackFailed, still under the lock.
    await assert.rejects(commitPathsWithMutation(root, ["a.md"], "chore: x", {
      mutate: async () => { throw new Error("mutation failed"); },
      rollback: async () => { throw new Error("cannot restore"); },
    }), (error) => error.code === "RollbackFailed" && /mutation failed; rollback failed: cannot restore/.test(error.message));
    assert.equal(fs.existsSync(path.join(root, ".contextcake.lock")), false, "the lock is released after RollbackFailed");
    // The happy path still commits only the named paths.
    const result = await commitPathsWithMutation(root, ["a.md"], "chore: a only", {
      mutate: async () => { await fsp.writeFile(a, "# A\n\ncommitted a\n"); await fsp.writeFile(b, "# B\n\ndirty b\n"); },
      rollback: async () => {},
    });
    assert.deepEqual(result, { committed: true });
    assert.equal(execFileSync("git", ["-C", root, "show", "--name-only", "--format=", "HEAD"], { env, encoding: "utf8" }).trim(), "a.md");
    assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain"], { env, encoding: "utf8" }).replace(/\n$/, ""), " M b.md", "the unnamed file stays dirty, not swept in");
  } finally { await cleanup(); }
});

test("scrub hides exactly what its old regex did, in linear time", () => {
  // The old regex, as the specification. It rescanned a run of scheme
  // characters from every letter in it (ReDoS), and git's stderr carries
  // whatever a remote prints.
  const REMOTE = /[a-z][a-z0-9+.-]*:\/\/\S+|git@\S+/gi;
  assert.equal(
    scrub("fatal: unable to access 'https://user:tok@github.com/o/r.git/': error: 403"),
    "fatal: unable to access '<remote> error: 403",
  );
  assert.equal(scrub("Permission denied for git@github.com:org/repo.git"), "Permission denied for <remote>");
  // Seeded, around the edges: runs with and without a letter, "://" and "git@"
  // followed by a blank or nothing, and case-folding lookalikes that [a-z]/i
  // does not match (Kelvin sign, long s).
  const pieces = ["a", "Z", "1", "+", ".", "-", ":", "/", "://", "@", "git", "GIT", " ", "\n", "https", String.fromCharCode(0x212a), String.fromCharCode(0x17f), String.fromCharCode(0xa0)];
  let state = 17;
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) >>> 16;
  let changed = 0;
  for (let i = 0; i < 50_000; i += 1) {
    let value = "";
    for (let length = next() % 12; length > 0; length -= 1) value += pieces[next() % pieces.length];
    const expected = value.replace(REMOTE, "<remote>");
    assert.equal(scrub(value), expected, JSON.stringify(value));
    if (expected !== value) changed += 1;
  }
  assert.ok(changed > 2_000, `too few URLs sampled: ${changed}`);

  const started = performance.now();
  assert.equal(scrub("a".repeat(300_000)), "a".repeat(300_000));
  assert.equal(scrub(`${"a".repeat(300_000)}:/`), `${"a".repeat(300_000)}:/`);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5_000, `hostile git output took ${Math.round(elapsed)} ms`);
});
