import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// The packaged app runs the identical CLI under ELECTRON_RUN_AS_NODE, so the
// Electron-bundled Node must satisfy the engines floor the published
// `contextcake` package declares (specs/contextcake-control-plane/spec.md
// §5.13). A silent Electron downgrade would otherwise ship a CLI on a Node
// the package claims not to support.
const here = path.dirname(fileURLToPath(import.meta.url))
const rootPkg = JSON.parse(fs.readFileSync(path.join(here, '..', '..', '..', 'package.json'), 'utf8'))

test('Electron-bundled Node satisfies the root engines floor', () => {
  const range = rootPkg.engines?.node ?? ''
  const floor = Number((range.match(/>=\s*(\d+)/) ?? [])[1])
  assert.ok(Number.isInteger(floor), `root engines.node ("${range}") must state a ">=N" floor`)

  const electron = path.join(here, '..', 'node_modules', '.bin', 'electron')
  const out = execFileSync(electron, ['-e', 'console.log(process.versions.node)'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  }).trim()
  const major = Number(out.split('.')[0])
  assert.ok(
    major >= floor,
    `Electron bundles Node ${out}, below the engines floor ${floor} from the root package.json`,
  )
})
