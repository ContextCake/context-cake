// Durable, local conflict-decision history.
//
// The resolver keeps dissent honest. This log records what a person (or the
// conservative formatter-only rule) chose to DO about that dissent after the
// contributing files were made to agree. It lives beside the manifest so the
// history follows this ContextCake setup without entering any source layer.

import fsp from "node:fs/promises";
import path from "node:path";
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

  async function recover(allowedRoots = [], committedTransactionIds = []) {
    const records = await list();
    const final = new Set(records.filter((r) => r.state === "committed" || r.state === "rolled_back").map((r) => r.id));
    const committedDecisions = new Set(committedTransactionIds);
    const pending = records.filter((r) => r.state === "prepared" && !final.has(r.id));
    const recovered = [];
    const failures = [];
    for (const tx of pending) {
      try {
        // A decision is appended only after every replacement succeeds. If the
        // process died before the journal's final marker, that durable decision
        // proves the write committed; rolling it back would make history lie.
        if (committedDecisions.has(tx.id)) {
          for (const target of tx.targets ?? []) {
            if (!insideAnyRoot(target.path, allowedRoots)
              || !insideAnyRoot(target.staged, allowedRoots)
              || !insideAnyRoot(target.backup, allowedRoots)) {
              throw new Error("journal target is outside the selected source roots");
            }
            await fsp.unlink(target.staged).catch(() => {});
            await fsp.unlink(target.backup).catch(() => {});
          }
          await append({ id: tx.id, state: "committed", recoveredAt: new Date().toISOString(), reason: "decision log confirmed commit" });
          continue;
        }
        for (const target of tx.targets ?? []) {
          if (!insideAnyRoot(target.path, allowedRoots) || !insideAnyRoot(target.backup, allowedRoots)) {
            throw new Error("journal target is outside the selected source roots");
          }
          await fsp.copyFile(target.backup, target.path);
          await fsp.unlink(target.staged).catch(() => {});
          await fsp.unlink(target.backup).catch(() => {});
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

function insideAnyRoot(target, roots) {
  const resolved = path.resolve(String(target));
  return roots.some((root) => {
    const base = path.resolve(root);
    const rel = path.relative(base, resolved);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}
