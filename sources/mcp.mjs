// MCP source adapter: spawns a foreign stdio MCP server, queries it, and
// translates its arbitrary (non-OKF) response into OKF concepts. Implements the
// source contract. Dependency-free (child_process + line framing).

import { spawn } from "node:child_process";
import readline from "node:readline";

export function createMcpSource({ name, level, command, args = [] }) {
  let child = null;
  let rl = null;
  let nextId = 1;
  let ready = null; // resolves once the MCP init handshake is complete
  let closed = false;
  const pending = new Map();
  let startError = null;

  // Reject every in-flight request immediately so a dead/unreachable source
  // degrades instantly instead of waiting for each request's timeout.
  function failAll(e) {
    startError = startError || e;
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(e); }
    pending.clear();
  }

  function ensureStarted() {
    if (closed || child || startError) return;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
    } catch (e) {
      startError = e;
      return;
    }
    // spawn() defers failures to async events: a missing binary fires "error";
    // a process that starts then dies (missing script, crash, clean exit) fires
    // "exit". Either way the child can no longer answer, so fail every pending
    // request now instead of waiting for timeouts. (On an intentional close()
    // pending is already empty, so this is a harmless no-op.)
    child.on("error", (e) => failAll(e));
    child.on("exit", () => failAll(new Error(`MCP source "${name}" exited`)));
    child.stdin.on("error", () => {}); // swallow EPIPE if the child is already gone
    rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
    // MCP handshake: await the initialize response, then send the required
    // notifications/initialized, before any tools/call is issued. Spec-compliant
    // foreign servers gate tool calls on this ordering. Failures are swallowed —
    // the in-flight tool call then rejects via startError and degrades.
    ready = send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "contextcake", version: "0.3.0" },
    })
      .then(() => notify("notifications/initialized"))
      .catch(() => {});
  }

  function notify(method, params) {
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); } catch {}
  }

  function send(method, params) {
    return new Promise((resolve, reject) => {
      if (startError) return reject(startError);
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`MCP source "${name}" timed out on ${method}`)); }
      }, 5000);
      timer.unref?.(); // don't let a pending timeout keep the process alive
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async function callTool(toolName, toolArgs) {
    ensureStarted();
    await ready; // wait for the init handshake (resolved/swallowed; never rejects)
    const result = await send("tools/call", { name: toolName, arguments: toolArgs });
    const text = result?.content?.[0]?.text;
    return text == null ? null : JSON.parse(text);
  }

  function warn(e) { console.error(`[mcp source "${name}"] unreachable: ${e.message} — resolving without it`); }

  return {
    name,
    level,
    async loadConcept(id) {
      try {
        const node = await callTool("get_node", { id });
        return node ? translateToOkf(node) : null;
      } catch (e) { warn(e); return null; }
    },
    async listConceptIds() {
      try {
        const res = await callTool("list_nodes", {});
        return res?.nodes ?? [];
      } catch (e) { warn(e); return []; }
    },
    close() {
      closed = true;
      if (rl) { try { rl.close(); } catch {} rl = null; }
      if (child) { try { child.kill(); } catch {} child = null; }
    },
  };
}

// The translation: arbitrary foreign shape -> OKF { frontmatter, sections }.
// foreign: { title, kind, facts:[{topic,text,lastTouched}], see_also:[] }
function translateToOkf(node) {
  const facts = node.facts ?? [];
  const newest = facts.reduce((m, f) => (f.lastTouched > m ? f.lastTouched : m), "") || null;
  const frontmatter = { type: node.kind ?? "concept", title: node.title ?? node.node, updated: newest };
  const sections = facts.map((f) => {
    const key = String(f.topic).toLowerCase();
    return {
      key,
      heading: `## ${f.topic} {#${key}}`,
      lines: String(f.text).split("\n"),
      updated: f.lastTouched ?? null,
      override: null,
    };
  });
  // Cross-references become a single Related section once per concept (not
  // duplicated onto every fact). The [[links]] stay discoverable by get_links.
  const related = node.see_also ?? [];
  if (related.length) {
    sections.push({
      key: "related",
      heading: "## Related {#related}",
      lines: [related.map((s) => `[[${s}]]`).join(", ")],
      updated: null,
      override: null,
    });
  }
  return { frontmatter, sections };
}
