// MCP source adapter: spawns a foreign stdio MCP server, queries it, and
// translates its arbitrary (non-OKF) response into OKF concepts. Implements the
// source contract. Dependency-free (child_process + line framing).

import { spawn } from "node:child_process";
import readline from "node:readline";

function spawnTrustedMcpCommand(command, args) {
  if (typeof command !== "string" || command.trim() === "" || command.includes("\0")) {
    throw new Error("MCP command must be a non-empty executable name or path");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("MCP command arguments must be strings without NUL bytes");
  }
  // MCP server execution is an intentional trust boundary, not interpolation:
  // direct manifests are trusted configuration, and the mutation API requires
  // an explicit `trusted: true` acknowledgement before persisting a command.
  // `shell: false` keeps command/args as an argv vector, so metacharacters have
  // no meaning unless the trusted command deliberately launches a shell.
  // See apps/site/src/content/docs/docs/concepts/trust-boundary.md.

  // codeql[js/command-line-injection]
  // lgtm[js/command-line-injection]
  return spawn(command.trim(), args, { stdio: ["pipe", "pipe", "inherit"], shell: false });
}

export function createMcpSource({ name, level, command, args = [], respawnCooldownMs = 3000 }) {
  let child = null;
  let rl = null;
  let nextId = 1;
  let ready = null; // resolves once the MCP init handshake is complete
  let closed = false;
  const pending = new Map();
  let startError = null;
  let lastSpawnAt = 0;
  // Honesty channel, duck-typing the github adapter's health() exactly. The
  // read methods degrade to null/[] so one dead child never sinks a resolve —
  // which makes a crashed server indistinguishable from an empty graph at the
  // read API. health() reports the last swallowed failure out of band. Scope is
  // always "index": a child failure stalls this source's whole graph, never
  // just one file, and service.mjs gates its "degraded" row on that literal.
  let lastError = null; // { at, message }
  let lastSuccessAt = null; // ms of the last read that actually answered

  function recordFailure(e) {
    lastError = { at: Date.now(), message: e.message };
  }

  function recordSuccess() {
    lastError = null;
    lastSuccessAt = Date.now();
  }

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
      child = spawnTrustedMcpCommand(command, args);
    } catch (e) {
      startError = e;
      recordFailure(e);
      return;
    }
    // spawn() defers failures to async events: a missing binary fires "error";
    // a process that starts then dies (missing script, crash, clean exit) fires
    // "exit". Either way reject every pending request now instead of waiting for
    // timeouts. On "exit" we also drop the child handle and clear rl/ready so the
    // next access past the cooldown respawns rather than failing forever.
    // Both paths record into health() directly: a child that dies between reads
    // must paint the source degraded on the next graph, not only after another
    // read happens to fail.
    child.on("error", (e) => { startError = startError || e; recordFailure(startError); rejectPending(e); });
    child.on("exit", () => {
      child = null;
      if (rl) { try { rl.close(); } catch { /* already gone */ } rl = null; }
      ready = null;
      const e = new Error(`MCP source "${name}" exited`);
      if (!closed) { startError = e; recordFailure(e); } // intentional close() → leave it closed, and not a health event
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
        recordSuccess(); // the call answered — a null node is an absent concept, not a failure
        return node ? translateToOkf(node) : null;
      } catch (e) { recordFailure(e); warn(e); return null; }
    },
    async listConceptIds() {
      try {
        const res = await callTool("list_nodes", {});
        recordSuccess();
        return res?.nodes ?? [];
      } catch (e) { recordFailure(e); warn(e); return []; }
    },
    // Add-time health check: unlike the read methods (which degrade to
    // null/[] so one dead source never sinks a resolve), probe() surfaces the
    // failure — a wrong command must be rejected while the user is still
    // looking at the form, not discovered as a hang on the first resolve.
    // tools/list is mandatory in the MCP spec, so any compliant server answers.
    // Bounded by the same per-request timeout as every other send().
    //
    // The answer is checked, not just received: this adapter only ever calls
    // list_nodes and get_node, so a server without both would pass a
    // transport-only probe and then sit as a permanently empty source — the
    // exact silent failure the probe exists to catch. err.code = "CONTRACT"
    // lets the caller word that differently from "did not respond".
    async probe() {
      ensureStarted();
      if (startError) throw startError;
      await ready;
      const result = await send("tools/list", {});
      const names = Array.isArray(result?.tools) ? result.tools.map((tool) => tool?.name) : null;
      if (!names || !names.includes("list_nodes") || !names.includes("get_node")) {
        const err = new Error("tools/list answered without list_nodes and get_node");
        err.code = "CONTRACT";
        throw err;
      }
      return result;
    },
    // What the read path refuses to say, same shape as the github adapter's:
    // a snapshot of already-recorded state — no request, no effect on reads.
    health() {
      return {
        ok: lastError === null,
        lastError: lastError ? lastError.message : null,
        lastErrorScope: lastError ? "index" : null, // a child failure is never scoped to one file
        lastErrorAt: lastError ? new Date(lastError.at).toISOString() : null,
        lastSuccessAt: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : null,
      };
    },
    async close() {
      closed = true;
      if (rl) { try { rl.close(); } catch {} rl = null; }
      const running = child;
      if (!running) return;
      try { running.stdin.end(); } catch {}
      try { running.kill("SIGTERM"); } catch {}
      if (!(await waitForExit(running, 300))) {
        try { running.kill("SIGKILL"); } catch {}
        await waitForExit(running, 700);
      }
      try { running.stdin.destroy(); } catch {}
      try { running.stdout.destroy(); } catch {}
      if (child === running) child = null;
    },
  };
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
  });
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
