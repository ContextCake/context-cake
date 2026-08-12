#!/usr/bin/env node
import { runCoreCli } from "./packages/core/src/bin-shim.mjs";
await runCoreCli("team-activity.mjs");
