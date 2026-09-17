// The spawned entrypoints both CLIs shipped before the command table. They
// keep their flags and raw output, so each is its own experimental family:
// no envelope contract to freeze. When a family replaces one (doctor, say),
// delete its entry here and register the new module in ./index.mjs.

import { defineFamily } from "../table.mjs";

function spawned(name, summary, mutation, spawn) {
  return defineFamily({
    name,
    stability: "experimental",
    summary,
    commands: [{ summary, mutation, manifest: spawn.manifest === "none" ? "none" : "optional", spawn }],
  });
}

export const doctor = spawned("doctor", "check profile configuration and source folders", "read", {
  entry: "doctor.mjs",
  manifest: "inject",
  // doctor reports a missing manifest itself, as NOT_FOUND in its own JSON.
  requireManifest: false,
});
export const mcp = spawned("mcp", "serve the resolved graph over stdio MCP", "serve", { entry: "mcp-server.mjs", manifest: "inject" });
export const resolve = spawned("resolve", "resolve a concept across layers", "read", { entry: "resolver.mjs", manifest: "inject" });
export const ingest = spawned("ingest", "classify repo events into signals", "write", { entry: "ingest.mjs", manifest: "none" });
export const write = spawned("write", "write captured signals into a layer", "write", { entry: "write.mjs", manifest: "inject" });
export const promote = spawned("promote", "promote a live capture inside one profile", "write", { entry: "promote.mjs", manifest: "inject" });
export const pack = spawned("pack", "inspect, install, update, and roll back local Packs", "write", { entry: "pack-cli.mjs", manifest: "inject-after-subcommand" });
