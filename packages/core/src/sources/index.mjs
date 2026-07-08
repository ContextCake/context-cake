// Builds source adapters from a manifest. Each layer declares a `source`
// ("okf-local" default, or "mcp"). Paths/commands resolve relative to the
// manifest's own directory.

import path from "node:path";
import { createOkfLocalSource } from "./okf-local.mjs";
import { createMcpSource } from "./mcp.mjs";

export function buildSources(manifest, manifestDir) {
  return (manifest.layers ?? []).map((layer) => {
    const kind = layer.source ?? "okf-local";
    const base = { name: layer.name, level: Number(layer.level) };
    if (kind === "okf-local") {
      return createOkfLocalSource({ ...base, root: path.resolve(manifestDir, layer.path) });
    }
    if (kind === "mcp") {
      return createMcpSource({
        ...base,
        command: layer.command,
        args: (layer.args ?? []).map((a) => (a.startsWith("./") || a.startsWith("../") ? path.resolve(manifestDir, a) : a)),
      });
    }
    throw new Error(`Unknown source kind "${kind}" for layer "${layer.name}"`);
  });
}
