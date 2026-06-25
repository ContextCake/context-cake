// MCP source adapter: spawns a foreign stdio MCP server, queries it, and
// translates its arbitrary (non-OKF) response into OKF concepts. Implements the
// source contract. Dependency-free (child_process + line framing).

import { spawn } from "node:child_process";
import readline from "node:readline";

export function createMcpSource({ name, level, command, args = [] }) {
  let child = null;
  let rl = null;
  let nextId = 1;
  const pending = new Map();
  let startError = null;

  function ensureStarted() {
    if (child || startError) return;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
    } catch (e) {
      startError = e;
      return;
    }
    child.on("error", (e) => { startError = e; });
    rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
    // fire-and-forget initialize handshake
    send("initialize", {}).catch(() => {});
  }

  function send(method, params) {
    return new Promise((resolve, reject) => {
      if (startError) return reject(startError);
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`MCP source "${name}" timed out on ${method}`)); }
      }, 5000);
    });
  }

  async function callTool(toolName, toolArgs) {
    const result = await send("tools/call", { name: toolName, arguments: toolArgs });
    const text = result?.content?.[0]?.text;
    return text == null ? null : JSON.parse(text);
  }

  function warn(e) { console.error(`[mcp source "${name}"] unreachable: ${e.message} — resolving without it`); }

  return {
    name,
    level,
    async loadConcept(id) {
      ensureStarted();
      try {
        const node = await callTool("get_node", { id });
        return node ? translateToOkf(node) : null;
      } catch (e) { warn(e); return null; }
    },
    async listConceptIds() {
      ensureStarted();
      try {
        const res = await callTool("list_nodes", {});
        return res?.nodes ?? [];
      } catch (e) { warn(e); return []; }
    },
    close() { if (child) { try { child.kill(); } catch {} child = null; } },
  };
}

// The translation: arbitrary foreign shape -> OKF { frontmatter, sections }.
// foreign: { title, kind, facts:[{topic,text,lastTouched}], see_also:[] }
function translateToOkf(node) {
  const newest = node.facts?.reduce((m, f) => (f.lastTouched > m ? f.lastTouched : m), "") || null;
  const frontmatter = { type: node.kind ?? "concept", title: node.title ?? node.node, updated: newest };
  const sections = (node.facts ?? []).map((f) => {
    const key = String(f.topic).toLowerCase();
    const seeAlso = (node.see_also ?? []).length ? `\n\nSee also: ${node.see_also.map((s) => `[[${s}]]`).join(", ")}` : "";
    return {
      key,
      heading: `## ${f.topic} {#${key}}`,
      lines: `${f.text}${seeAlso}`.split("\n"),
      updated: f.lastTouched ?? null,
      override: null,
    };
  });
  return { frontmatter, sections };
}
