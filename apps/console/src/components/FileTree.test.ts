// buildTree's identity contract.
//
// A row's id keys the React child, `indexById`, and the registered DOM node, so
// two rows sharing one id is not a cosmetic problem: the pre-order walk follows
// `children.get(node.id)`, and a collision makes it descend into somebody
// else's subtree. Both shapes below were real with `<layer>/<rel>` ids.
import { describe, expect, it } from 'vitest'
import { ancestorsOfId, buildTree } from './FileTree'
import type { LayerFile, LayerFiles } from '../types'

function file(layer: string, rel: string): LayerFile {
  const name = rel.slice(rel.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return {
    path: `${layer}/${rel}`, name, rel,
    ext: dot > 0 ? name.slice(dot) : '',
    kind: 'text', markdown: rel.endsWith('.md'),
  }
}

function layer(name: string, rels: string[]): LayerFiles {
  return {
    layer: name, kind: 'files', root: `/${name}`, fileCount: rels.length, truncated: false,
    files: rels.map((rel) => file(name, rel)),
  }
}

const filePaths = (entries: ReturnType<typeof buildTree>) =>
  entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path)

describe('buildTree ids', () => {
  it('keeps a file and the sibling folder of the same name apart', () => {
    // `notes` the file and `notes/` the folder both hashed to "vault/notes",
    // so the walk descended into the folder's children a second time: five
    // file rows — two of them duplicate React keys — for three files.
    const entries = buildTree([layer('vault', ['notes', 'notes/a.md', 'notes/b.md'])])

    expect(filePaths(entries).sort()).toEqual(['vault/notes', 'vault/notes/a.md', 'vault/notes/b.md'])
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length)
  })

  it('keeps a layer named like a folder path out of that folder', () => {
    // validateContextManifest accepts a layer literally named `a/b`, and
    // /api/files then lists it. Its root id was "a/b" — the same string as the
    // `b/` folder inside the layer named `a`, whose two files then vanished.
    const entries = buildTree([layer('a', ['b/c.md', 'b/d.md']), layer('a/b', ['e.md'])])

    expect(filePaths(entries).sort()).toEqual(['a/b/c.md', 'a/b/d.md', 'a/b/e.md'])
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length)
    // Two roots, and the folder is still inside the layer that owns it.
    expect(entries.filter((entry) => entry.depth === 0).map((entry) => entry.name)).toEqual(['a', 'a/b'])
  })

  it('walks a row back up to its layer root', () => {
    const entries = buildTree([layer('vault', ['Projects/deep/beta.md'])])
    const beta = entries.find((entry) => entry.path === 'vault/Projects/deep/beta.md')!
    const chain = ancestorsOfId(beta.id)

    expect(chain).toEqual(entries.filter((entry) => entry.kind === 'dir').map((entry) => entry.id))
    expect(chain[0]).toBe(entries.find((entry) => entry.depth === 0)!.id)
  })
})
