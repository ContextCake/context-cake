// "Reveal in Finder", resolved in the main process.
//
// The renderer asks for a LAYER NAME and a RELATIVE PATH — never an absolute
// one. That is the whole design: `shell.showItemInFolder` will happily open a
// Finder window on anything the main process hands it, so a channel that
// accepted a path would let a compromised renderer point the user's Finder at
// any file on the machine. Here the only thing the renderer can influence is
// which layer, and where inside it; the root comes from the manifest on disk.
//
// The containment check is the engine's own, imported rather than copied:
// `layerRootMap` (which layers have a folder at all — mcp and REST-read github
// layers are structurally absent) and `assertInsideRoot` (which refuses "..",
// an absolute rel, and symlinks pointing out of the root). An escaping path is
// REFUSED, never clamped back to the root: clamping would answer a request the
// user did not make, and quietly.
//
// No Electron imports, so this is exercised directly by scripts/navigation-test.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const engines = new Map()

/**
 * The engine modules this needs, loaded once per engine root. Dynamic because
 * the engine lives at a different absolute path in a dev checkout and in a
 * packaged bundle (see paths.mjs), and lazy so a reveal that never happens
 * costs the app nothing at boot.
 */
function loadEngine(engineSrc) {
  if (!engines.has(engineSrc)) {
    engines.set(engineSrc, Promise.all([
      import(pathToFileURL(path.join(engineSrc, 'layer-files.mjs')).href),
      import(pathToFileURL(path.join(engineSrc, 'http-util.mjs')).href),
      import(pathToFileURL(path.join(engineSrc, 'manifest.mjs')).href),
    ]))
  }
  return engines.get(engineSrc)
}

/**
 * Absolute path for `<layer>/<rel>`, or a throw explaining the refusal.
 * Never returns a path outside the named layer's root.
 */
export async function resolveRevealTarget({ layer, rel = '', manifestFile, engineSrc }) {
  if (typeof layer !== 'string' || !layer) throw new Error('Reveal needs the name of a source.')
  if (typeof rel !== 'string') throw new Error('Reveal needs a path inside that source.')
  const [{ layerRootMap }, { assertInsideRoot }, { getManifestProfileLayers }] = await loadEngine(engineSrc)

  let manifest
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) }
  catch { throw new Error('ContextCake could not read its list of sources.') }

  // The same profile-unified view every engine read site builds, so a manifest
  // migrated to v2 still resolves its layers here.
  let roots
  try {
    roots = layerRootMap({ ...manifest, layers: getManifestProfileLayers(manifest) }, path.dirname(manifestFile))
  } catch { throw new Error('ContextCake could not read its list of sources.') }

  const entry = roots.get(layer)
  if (!entry) throw new Error(`“${layer}” keeps no files on this machine.`)

  const abs = path.resolve(entry.root, rel)
  const real = assertInsideRoot(abs, entry.root, `That path is outside the folder for “${layer}”.`)
  if (!fs.existsSync(real)) throw new Error('That file is no longer on disk.')
  return real
}
