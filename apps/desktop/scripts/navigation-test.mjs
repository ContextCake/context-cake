import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isEngineOrigin } from '../src/main/navigation.mjs'
import { resolveRevealTarget } from '../src/main/reveal.mjs'
import { TRUSTED_IPC_ROLES, trustedRolesForChannel } from '../src/main/trusted-windows.mjs'

const origin = 'http://127.0.0.1:4317'

assert.equal(isEngineOrigin(`${origin}/console/`, origin), true)
assert.equal(isEngineOrigin(`${origin}/api/graph`, origin), true)
assert.equal(isEngineOrigin(`http://127.0.0.1:4317@attacker.example/`, origin), false)
assert.equal(isEngineOrigin('https://127.0.0.1:4317/console/', origin), false)
assert.equal(isEngineOrigin('not a URL', origin), false)

// ---- Reveal in Finder -------------------------------------------------------
// The IPC exists, is main-window-only, and goes through the trusted gate — a
// plain ipcMain.handle would skip the sender check entirely.
assert.deepEqual([...trustedRolesForChannel('contextcake:reveal-file')], ['main'])
assert.ok(Object.hasOwn(TRUSTED_IPC_ROLES, 'contextcake:reveal-file'))

const here = path.dirname(fileURLToPath(import.meta.url))
const engineSrc = path.resolve(here, '..', '..', '..', 'packages', 'core', 'src')
const preload = fs.readFileSync(path.resolve(here, '..', 'src', 'preload.cjs'), 'utf8')
const mainSource = fs.readFileSync(path.resolve(here, '..', 'src', 'main', 'main.mjs'), 'utf8')
assert.match(mainSource, /handleTrustedIpc\('contextcake:reveal-file'/)
assert.match(preload, /revealFile:/)
// The bridge must not offer the main process a path of the renderer's
// choosing — that is the whole containment argument.
assert.doesNotMatch(preload, /reveal-file',\s*\{\s*path/)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reveal-'))
const layerRoot = path.join(tmp, 'vault')
const outside = path.join(tmp, 'outside')
fs.mkdirSync(path.join(layerRoot, 'notes'), { recursive: true })
fs.mkdirSync(outside, { recursive: true })
fs.writeFileSync(path.join(layerRoot, 'notes', 'a.md'), '# A\n')
fs.writeFileSync(path.join(outside, 'private.md'), '# private\n')
fs.symlinkSync(path.join(outside, 'private.md'), path.join(layerRoot, 'escape.md'))

const manifestFile = path.join(tmp, 'manifest.json')
fs.writeFileSync(manifestFile, JSON.stringify({
  version: 2,
  profiles: {
    default: {
      layers: [
        { name: 'vault', level: 3, source: 'files', path: layerRoot },
        { name: 'graph', level: 1, source: 'mcp', command: 'node', args: ['nope.mjs'] },
      ],
    },
  },
}))

const reveal = (layer, rel) => resolveRevealTarget({ layer, rel, manifestFile, engineSrc })
const refused = async (label, layer, rel) => {
  await assert.rejects(reveal(layer, rel), (err) => err instanceof Error, `${label} must be refused`)
}

assert.equal(await reveal('vault', 'notes/a.md'), fs.realpathSync.native(path.join(layerRoot, 'notes', 'a.md')))
assert.equal(await reveal('vault', ''), fs.realpathSync.native(layerRoot))

await refused('traversal out of the layer root', 'vault', '../outside/private.md')
await refused('deep traversal', 'vault', 'notes/../../outside/private.md')
await refused('an absolute path', 'vault', path.join(outside, 'private.md'))
await refused('a symlink pointing out of the root', 'vault', 'escape.md')
await refused('a layer with no folder on disk', 'graph', 'anything.md')
await refused('an unknown layer', 'nope', 'a.md')
await refused('a missing file', 'vault', 'notes/gone.md')
await refused('a non-string layer', 42, 'notes/a.md')
await refused('a non-string rel', 'vault', { toString: () => 'notes/a.md' })

// One malformed layer must not take the healthy ones with it. A strict manifest
// read throws on the whole file, which disabled Reveal for every source in the
// app while the console went on listing and browsing the sources that were
// fine — the same failure mode service.mjs's quarantined read exists to remove.
fs.writeFileSync(manifestFile, JSON.stringify({
  version: 2,
  profiles: {
    default: {
      layers: [
        { name: 'vault', level: 3, source: 'files', path: layerRoot },
        { name: 'graph', level: 1, source: 'mcp', command: 'node', args: ['nope.mjs'] },
        { name: 'noplace', level: 1 }, // hand-edited: an okf-local layer with no path
      ],
    },
  },
}))

assert.equal(await reveal('vault', 'notes/a.md'), fs.realpathSync.native(path.join(layerRoot, 'notes', 'a.md')))
assert.equal(await reveal('vault', ''), fs.realpathSync.native(layerRoot))
await refused('traversal, with a broken layer in the manifest', 'vault', '../outside/private.md')
await refused('a layer with no folder, with a broken layer in the manifest', 'graph', 'anything.md')
// And the refusal for the broken layer names that layer, not the whole list.
await assert.rejects(
  reveal('noplace', 'a.md'),
  (err) => err instanceof Error && err.message.includes('noplace') && !/list of sources/.test(err.message),
  'a quarantined layer must be refused by name',
)

fs.rmSync(tmp, { recursive: true, force: true })

console.log('navigation test passed (exact engine origin only; reveal-in-finder stays inside a layer root, refuses escapes, and survives one broken layer)')
