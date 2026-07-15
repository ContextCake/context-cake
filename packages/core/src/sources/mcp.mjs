// MCP source adapter: spawns a foreign stdio MCP server, queries it, and
// translates its arbitrary (non-OKF) response into OKF concepts. Implements the
// source contract. Dependency-free (child_process + line framing).

import { spawn } from "node:child_process";
import readline from "node:readline";

export function createMcpSource({ name, level, command, args = [], respawnCooldownMs = 3000 }) {
  let child = null;
  let rl = null;
  let nextId = 1;
  let ready = null; // resolves once the MCP init handshake is complete
  let closed = false;
  const pending = new Map();
  let startError = null;
  let lastSpawnAt = 0;

  // Reject every in-flight request immediately so a dead/unreachable source
  // degrades instantly instead of waiting for each request's timeout.
  function rejectPending(e) {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(e); }
    pending.clear();
  }

  function ensureStarted() {
    if (closed || child) return;
    // A source that spawned then died must be able to come back — the service
    // now holds one adapter set across many reads, so a one-time crash can't be
    // allowed to kill the source for the process's lifetime. Stay degraded only
    // for a short cooldown after the last spawn (so a single burst read doesn't
    // respawn-storm a genuinely broken child), then allow a fresh attempt.
    if (startError && Date.now() - lastSpawnAt < respawnCooldownMs) return;
    startError = null;
    ready = null;
    lastSpawnAt = Date.now();
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
    } catch (e) {
      startError = e;
      return;
    }
    // spawn() defers failures to async events: a missing binary fires "error";
    // a process that starts then dies (missing script, crash, clean exit) fires
    // "exit". Either way reject every pending request now instead of waiting for
    // timeouts. On "exit" we also drop the child handle and clear rl/ready so the
    // next access past the cooldown respawns rather than failing forever.
    child.on("error", (e) => { startError = startError || e; rejectPending(e); });
    child.on("exit", () => {
      child = null;
      if (rl) { try { rl.close(); } catch { /* already gone */ } rl = null; }
      ready = null;
      const e = new Error(`MCP source "${name}" exited`);
      if (!closed) startError = e; // intentional close() → leave it closed
      rejectPending(e);
    });
    child.stdin.on("error", () => {}); // swallow EPIPE if the child is already gone
    rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (line.length > 10_000_000) return; // ignore an oversized line from an untrusted foreign source
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
    const topic = String(f.topic ?? "untitled");
    const key = topic.toLowerCase();
    return {
      key,
      heading: `## ${topic} {#${key}}`,
      lines: String(f.text ?? "").split("\n"),
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
