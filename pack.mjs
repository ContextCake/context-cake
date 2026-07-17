#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, "packages/core/src/pack-cli.mjs");
process.argv[1] = target;
await import(pathToFileURL(target).href);
