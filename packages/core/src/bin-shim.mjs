// Backs the root-level CLI wrappers (`node resolver.mjs`, `node write.mjs`, …).
//
// Those names are the public command surface and predate the move of the
// engine into packages/core, so each one survives at the repo root as a
// three-line file that calls runCoreCli() with the module it fronts. Before
// nine copies of this logic sat inline at the root and drifted independently.
//
// process.argv[1] is rewritten to the real module *before* importing it: the
// CLIs read argv[1] to print usage, and without the rewrite every one of them
// would name the wrapper instead of itself.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CORE_SRC = path.dirname(fileURLToPath(import.meta.url));

export async function runCoreCli(moduleName) {
  const target = path.join(CORE_SRC, moduleName);
  process.argv[1] = target;
  await import(pathToFileURL(target).href);
}
