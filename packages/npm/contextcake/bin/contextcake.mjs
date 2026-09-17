#!/usr/bin/env node
// The standalone npm CLI carries the same dependency-free engine that ships in
// ContextCake for Mac, and the same dispatcher (engine/cli.mjs). It
// intentionally has no install or lifecycle scripts.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../engine/cli.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'package.json'), 'utf8'))

await main(process.argv.slice(2), { version })
