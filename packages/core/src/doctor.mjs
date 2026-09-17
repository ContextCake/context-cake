#!/usr/bin/env node
// The observability probe behind `contextcake doctor`. The checks themselves
// run in-process (control/doctor.mjs, cli/families/doctor.mjs); this entry
// exists for the Mac app's CLI, whose wrapSpawn hook routes the `doctor`
// spawn through apps/desktop/src/observability/doctor-launcher.mjs. That
// launcher checks the device-local collector, then calls main() with the
// result, which is written to stdout as one JSON line for the family to read.
// Run anywhere else, it reports that nothing was checked.

import path from "node:path";
import { fileURLToPath } from "node:url";

export const NOT_CHECKED = Object.freeze({
  state: "not-checked",
  note: "Local observability is checked by the Mac app's CLI. No running-app history is read.",
});

export async function main({ observability = null } = {}) {
  process.stdout.write(`${JSON.stringify(observability ?? NOT_CHECKED)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) await main();
