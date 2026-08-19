// Durable, local conflict-decision history.
//
// The resolver keeps dissent honest. This log records what a person (or the
// conservative formatter-only rule) chose to DO about that dissent after the
// contributing files were made to agree. It lives beside the manifest so the
// history follows this ContextCake setup without entering any source layer.

import fsp from "node:fs/promises";
import path from "node:path";
import { realpathLenient } from "./http-util.mjs";
import { ensureSidecarMigrated, sidecarDir } from "./sidecar-state.mjs";

const SCHEMA_VERSION = 1;
const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2]);

/**
 * A deliberately narrow equivalence rule for the magic wand.
 *
 * We accept prose whose word/number tokens are identical in the same order and
 * whose only differences are case, punctuation, whitespace, or Markdown
 * emphasis. Anything code-shaped or link-shaped stays a human decision.
 */
export function trivialConflictReason(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const signatures = values.map(trivialSignature);
  if (signatures.some((s) => s === null) || new Set(signatures).size !== 1) return null;
  return "The answers use the same words in the same order; only formatting differs.";
}

function trivialSignature(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  // Code, links, HTML, tables, and URLs carry meaning in their punctuation.
  if (/```|~~~|`|!?\[[^\]]*\]\(|<\/?[a-z][^>]*>|https?:\/\/|\|[^\n]*\|/i.test(value)) return null;
  const withoutEmphasis = value.normalize("NFKC").replace(/[*_~]/g, "").toLocaleLowerCase("en-US");
  const tokens = withoutEmphasis.match(/[\p{L}\p{N}]+/gu);
  return tokens?.length ? tokens.join("\u001f") : null;
}

export function createConflictResolutionLog(manifestPath, { profileId = "default" } = {}) {
  const dir = sidecarDir(manifestPath, profileId);
  const file = path.join(dir, "conflict-resolutions.ndjson");
  let appendTail = Promise.resolve();

  async function prepare() {
    await ensureSidecarMigrated(manifestPath);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const handle = await fsp.open(file, "a", 0o600);
    await handle.close();
  }

  async function list() {
    await ensureSidecarMigrated(manifestPath);
    let text;
    try { text = await fsp.readFile(file, "utf8"); }
    catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
    const records = [];
    for (const [index, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (!SUPPORTED_SCHEMA_VERSIONS.has(record?.schemaVersion) || typeof record.id !== "string") {
          throw new Error("unsupported record");
        }
        records.push(record);
      } catch (err) {
        throw new Error(`Conflict resolution history is unreadable at line ${index + 1}: ${err.message}`);
      }
    }
    return records;
  }

  async function append(record) {
    await prepare();
    const saved = { schemaVersion: record.schemaVersion ?? SCHEMA_VERSION, ...record };
    appendTail = appendTail.then(() => fsp.appendFile(file, `${JSON.stringify(saved)}\n`, { encoding: "utf8", mode: 0o600 }));
    await appendTail;
    return saved;
  }

  async function find(id) {
    return (await list()).find((record) => record.id === id) ?? null;
  }

  return { file, prepare, list, append, find };
}

export function createDiscrepancyTransactionJournal(manifestPath, { profileId = "default" } = {}) {
  const dir = sidecarDir(manifestPath, profileId);
  const file = path.join(dir, "discrepancy-transactions.ndjson");
  let appendTail = Promise.resolve();

  async function append(record) {
    await ensureSidecarMigrated(manifestPath);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    appendTail = appendTail.then(() => fsp.appendFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 }));
    await appendTail;
    return record;
  }

  async function list() {
    await ensureSidecarMigrated(manifestPath);
    let text;
    try { text = await fsp.readFile(file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    return text.split("\n").filter(Boolean).map((line, index) => {
      try { return JSON.parse(line); }
      catch { throw new Error(`Discrepancy transaction journal is unreadable at line ${index + 1}`); }
    });
  }

  // `onRestored(tx, paths)` runs after every backup of a rolled-back
  // transaction has been copied into place and BEFORE the staged/backup files
  // are removed or the journal marks `rolled_back`: a host that has to record
  // the restore elsewhere (the live team layer commits it, so git and this log
  // agree) gets to do so while a failure still leaves the transaction pending
  // and retryable — the backups are only dropped once the hook has returned.
  //
  // A target with `created: true` was being CREATED by the transaction (it had
  // no backup — `backup: null`); restoring it means removing what the
  // transaction placed at `path`. While the staged copy is still beside it,
  // the two are compared and a file whose bytes differ is left alone — it is
  // someone's edit, not our placement. Only when the staged copy is already
  // gone is the file removed unconditionally; that is bounded to the
  // journal's `prepared` window and can in principle remove bytes someone
  // wrote there between the crash and this restart — accepted, and called
  // out in the discrepancy spec.
  async function recover(allowedRoots = [], committedTransactionIds = [], { onRestored = null } = {}) {
    const records = await list();
    const final = new Set(records.filter((r) => r.state === "committed" || r.state === "rolled_back").map((r) => r.id));
    const committedDecisions = new Set(committedTransactionIds);
    const pending = records.filter((r) => r.state === "prepared" && !final.has(r.id));
    const recovered = [];
    const failures = [];
    // Every journaled file of a target must sit inside a selected root before
    // it is read, copied, or unlinked. `null` (a created target's backup) is
    // simply absent — never resolved as a path.
    const assertContained = (target, fields) => {
      for (const field of fields) {
        const file = target[field];
        if (file === null || file === undefined) continue;
        if (!insideAnyRoot(file, allowedRoots)) throw new Error("journal target is outside the selected source roots");
      }
    };
    for (const tx of pending) {
      try {
        // A decision is appended only after every replacement succeeds. If the
        // process died before the journal's final marker, that durable decision
        // proves the write committed; rolling it back would make history lie.
        if (committedDecisions.has(tx.id)) {
          for (const target of tx.targets ?? []) {
            assertContained(target, ["path", "staged", "backup"]);
            await unlinkIfPresent(target.staged);
            await unlinkIfPresent(target.backup);
          }
          await append({ id: tx.id, state: "committed", recoveredAt: new Date().toISOString(), reason: "decision log confirmed commit" });
          continue;
        }
        for (const target of tx.targets ?? []) {
          assertContained(target, ["path", "backup", "staged"]);
          if (target.created === true) {
            if (await placedByTransaction(target)) {
              await fsp.unlink(target.path).catch((error) => { if (error.code !== "ENOENT") throw error; });
            }
          } else {
            await fsp.copyFile(target.backup, target.path);
          }
        }
        if (onRestored) await onRestored(tx, (tx.targets ?? []).map((target) => target.path));
        for (const target of tx.targets ?? []) {
          await unlinkIfPresent(target.staged);
          await unlinkIfPresent(target.backup);
        }
        await append({ id: tx.id, state: "rolled_back", recoveredAt: new Date().toISOString(), reason: "startup recovery" });
        recovered.push(tx.id);
      } catch (error) {
        await append({ id: tx.id, state: "recovery_required", failedAt: new Date().toISOString(), error: error.message });
        failures.push(`${tx.id}: ${error.message}`);
      }
    }
    if (failures.length) throw new Error(`Recovery is required for ${failures.join("; ")}`);
    return recovered;
  }

  return { file, append, list, recover };
}

async function unlinkIfPresent(file) {
  if (typeof file !== "string") return;
  await fsp.unlink(file).catch(() => {});
}

// Whether the file at a created target's `path` is the transaction's own
// placement: byte-identical to the staged copy. With no staged copy left to
// compare against, the answer is yes (see recover()).
async function placedByTransaction(target) {
  if (typeof target.staged !== "string") return true;
  let staged;
  try { staged = await fsp.readFile(target.staged); } catch { return true; }
  let placed;
  try { placed = await fsp.readFile(target.path); } catch (error) { return error.code !== "ENOENT"; }
  return staged.equals(placed);
}

// Containment for journal targets. Both sides are compared as real paths:
// the writers record realpaths (assertInsideRoot resolves symlinks before a
// target is ever staged) while a manifest's layer path may reach the same
// folder through a symlink — every macOS temp dir, /var → /private/var — and
// a string compare would then refuse to recover a perfectly contained file.
// A path that no longer exists (a staged file already cleaned up, a created
// target whose folder went with it) resolves through its deepest existing
// ancestor, the same rule assertInsideRoot uses. Anything that is not a path
// string is not inside any root.
function insideAnyRoot(target, roots) {
  if (typeof target !== "string" || !target) return false;
  const resolved = realpathLenient(target);
  return roots.some((root) => {
    const base = realpathLenient(root);
    const rel = path.relative(base, resolved);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}
