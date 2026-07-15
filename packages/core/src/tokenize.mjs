// Server-side token counting for the engine service's context-budget view
// (/api/graph). Uses a vendored o200k_base BPE tokenizer (js-tiktoken lite).
// o200k is GPT-4o's tokenizer; Anthropic does not publish Claude's, so treat
// this as a close proxy. Vendored under vendor/tiktoken — no npm, no network.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Tiktoken } from "./vendor/tiktoken/lite.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TOKENIZER = "o200k_base";

let enc = null;
function encoder() {
  if (!enc) {
    const ranks = JSON.parse(fs.readFileSync(path.join(HERE, "vendor/tiktoken/o200k_base.json"), "utf8"));
    enc = new Tiktoken(ranks);
  }
  return enc;
}

export function countTokens(text) {
  if (!text) return 0;
  try { return encoder().encode(String(text)).length; } catch { return 0; }
}

// Approximate the text a source/agent actually carries for a concept:
// frontmatter as `key: value` lines + each section heading and body.
export function conceptText(entry) {
  if (!entry) return "";
  const fm = Object.entries(entry.frontmatter ?? {})
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join("\n");
  const body = (entry.sections ?? [])
    .map((s) => `${s.heading ?? ""}\n${(s.lines ? s.lines.join("\n") : s.content) ?? ""}`)
    .join("\n\n");
  return `${fm}\n\n${body}`.trim();
}
