---
type: decision
title: Source adapter contract
updated: 2026-06-24
tags: [architecture, adapters]
---

# Source adapter contract

## Interface {#interface}

Every source implements three methods plus two properties:

```js
{
  name: string,           // layer name (e.g. "team")
  level: number,          // precedence (higher wins)
  async loadConcept(id)   // → { frontmatter, sections } | null
  async listConceptIds()  // → string[]
  close()                 // release resources (noop for okf-local; kills child for mcp)
}
```

`loadConcept` powers `read_file`. `listConceptIds` powers `search`, `list_concepts`,
and `get_links` so they see every source — not just filesystem ones. Without this,
a foreign MCP source would be invisible to discovery.

## Failure handling {#failure}

An unreachable source warns and returns `null` / `[]` — it does not fail the whole
resolution. The remaining reachable layers resolve normally; the missing source
appears as a warning in the output.

## Engine constraint {#engine-constraint}

The engine (`resolver.mjs`, `sources/`) is dependency-free — plain Node.js built-ins
only. Do not add npm dependencies to the resolution path without discussion.

## Real adapters {#real-adapters}

Currently implemented: `okf-local`, `mcp` (generic foreign MCP with a mock).
Deferred: membrain adapter (needs a shim — membrain speaks `search_nodes`/`open_nodes`,
not the `list_nodes`/`get_node` protocol the MCP adapter expects).

## Related {#related}

[[layer-structure]], [[resolution-model]]
