// Server-side token counting for the engine service's context-budget view
// (/api/graph). Uses a vendored o200k_base BPE tokenizer (js-tiktoken lite).
// o200k is GPT-4o's tokenizer; Anthropic does not publish Claude's, so treat
// this as a close proxy. Vendored under vendor/tiktoken — no npm, no network.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Tiktoken } from "./vendor/tiktoken/lite.js";
import { sectionText } from "./sections.mjs";

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

// Building the encoder is a one-time ~800ms synchronous block (2.3MB rank
// table). Hosts call this at boot so the cost is never paid mid-request. The
// desktop engine is isolated from the UI in a utility process, but its own HTTP
// loop still benefits from paying this cost before the first indexed read.
export function warmTokenizer() {
  try { encoder(); } catch { /* countTokens degrades to 0 on a broken vendor file */ }
}

// Exact BPE beyond this many characters is CPU-bound for seconds per megabyte —
// and countTokens runs on every doc during background indexing. Encode a prefix
// exactly and extrapolate for oversized texts:
// the count is a budgeting proxy either way (o200k vs Claude), and a bounded
// estimate beats pinning the UI on a giant generated markdown file.
const EXACT_ENCODE_LIMIT = 200_000;

export function countTokens(text) {
  if (!text) return 0;
  const s = String(text);
  try {
    if (s.length <= EXACT_ENCODE_LIMIT) return encoder().encode(s).length;
    const prefix = encoder().encode(s.slice(0, EXACT_ENCODE_LIMIT)).length;
    return Math.round((prefix * s.length) / EXACT_ENCODE_LIMIT);
  } catch { return 0; }
}

// Approximate the text a source/agent actually carries for a concept:
// frontmatter as `key: value` lines + each section heading and body.
export function conceptText(entry) {
  if (!entry) return "";
  const fm = Object.entries(entry.frontmatter ?? {})
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join("\n");
  const body = (entry.sections ?? [])
    .map((s) => `${s.heading ?? ""}\n${sectionText(s)}`)
    .join("\n\n");
  return `${fm}\n\n${body}`.trim();
}
