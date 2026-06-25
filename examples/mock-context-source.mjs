#!/usr/bin/env node
// A deliberately NON-OKF mock "context source" exposed over stdio MCP. Stands in
// for "some foreign graph you can only reach via MCP." Two tools:
//   list_nodes -> { nodes: ["decisions/database-engine", ...] }
//   get_node {id} -> arbitrary non-OKF record (or null)
// The mcp source adapter translates this into OKF concepts.

import readline from "node:readline";

const GRAPH = {
  "decisions/database-engine": {
    node: "database-engine",
    category: "decisions",
    title: "Database engine",
    kind: "decision",
    facts: [
      { topic: "Engine", text: "Postgres (org standard).", lastTouched: "2026-06-01" },
      { topic: "Backups", text: "Nightly snapshots to cold storage.", lastTouched: "2026-03-01" },
    ],
    see_also: ["decisions/scaling-policy"],
  },
  "decisions/observability": {
    node: "observability",
    category: "decisions",
    title: "Observability",
    kind: "decision",
    facts: [
      { topic: "Tracing", text: "All services emit OpenTelemetry traces to the org collector.", lastTouched: "2026-04-10" },
    ],
    see_also: [],
  },
};

const tools = [
  { name: "list_nodes", description: "List node ids.", inputSchema: { type: "object", properties: {} } },
  { name: "get_node", description: "Get one node by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = msg;
  if (method === "initialize") return reply(id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock-context-source", version: "0.1.0" } });
  if (method === "notifications/initialized") return;
  if (method === "tools/list") return reply(id, { tools });
  if (method === "tools/call") {
    const { name, arguments: a = {} } = params;
    if (name === "list_nodes") return replyText(id, { nodes: Object.keys(GRAPH) });
    if (name === "get_node") return replyText(id, GRAPH[a.id] ?? null);
    return error(id, `unknown tool ${name}`);
  }
  return error(id, `unknown method ${method}`);
});

function reply(id, result) { write({ jsonrpc: "2.0", id, result }); }
function replyText(id, obj) { write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(obj) }] } }); }
function error(id, message) { write({ jsonrpc: "2.0", id, error: { code: -32000, message } }); }
function write(m) { process.stdout.write(`${JSON.stringify(m)}\n`); }
