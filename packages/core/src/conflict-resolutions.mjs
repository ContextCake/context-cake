// Durable, local conflict-decision history.
//
// The resolver keeps dissent honest. This log records what a person (or the
// conservative formatter-only rule) chose to DO about that dissent after the
// contributing files were made to agree. It lives beside the manifest so the
// history follows this ContextCake setup without entering any source layer.

import fsp from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;

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

export function createConflictResolutionLog(manifestPath) {
  const dir = path.join(path.dirname(path.resolve(manifestPath)), ".contextcake");
  const file = path.join(dir, "conflict-resolutions.ndjson");
  let appendTail = Promise.resolve();

  async function prepare() {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const handle = await fsp.open(file, "a", 0o600);
    await handle.close();
  }

  async function list() {
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
        if (record?.schemaVersion !== SCHEMA_VERSION || typeof record.id !== "string") {
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
    const saved = { schemaVersion: SCHEMA_VERSION, ...record };
    appendTail = appendTail.then(() => fsp.appendFile(file, `${JSON.stringify(saved)}\n`, { encoding: "utf8", mode: 0o600 }));
    await appendTail;
    return saved;
  }

  async function find(id) {
    return (await list()).find((record) => record.id === id) ?? null;
  }

  return { file, prepare, list, append, find };
}
