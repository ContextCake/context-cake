// @vitest-environment jsdom
//
// FileTree's own keyboard handling (APG tree pattern) is implemented in JS —
// not relying on any browser default the way a native `<input type="radio">`
// does — so unlike radio-group arrow navigation (see Conflicts.test.tsx),
// jsdom CAN verify it: `onKeyDown` is a plain React handler reacting to a
// dispatched `keydown` DOM event, trusted or not.
//
// A DOM-level accessibility audit flagged this tree as having no working
// ArrowDown navigation (F22c). Manual verification in a real browser (Chrome,
// via CDP-level keyboard input) found ArrowDown/ArrowUp/ArrowRight/
// ArrowLeft/Home/End all already move focus correctly — ArrowDown from the
// root row landed on its first child ("company" → "company/assets"), and End
// reached the last visible row. These tests lock that in as a regression
// guard rather than changing behavior that already works.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildTree, FileTree, flattenTree } from './FileTree'
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

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function activeRow(): HTMLElement | null {
  return container.querySelector('[role="treeitem"][tabindex="0"]')
}

async function press(key: string) {
  await act(async () => {
    activeRow()?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

describe('FileTree keyboard navigation', () => {
  it('moves the roving tab stop with ArrowDown/ArrowUp and jumps with Home/End', async () => {
    const entries = buildTree([layer('vault', ['assets/a.md', 'notes/b.md', 'notes/c.md'])])
    await act(async () => root.render(
      <FileTree entries={entries} expandAll selected={null} reveal={null} onSelect={() => {}} layerIds={new Map()} label="Sources" />,
    ))

    expect(activeRow()?.getAttribute('title')).toBe('vault')

    await press('ArrowDown')
    expect(activeRow()?.getAttribute('title')).toBe('vault/assets')

    await press('ArrowDown')
    expect(activeRow()?.getAttribute('title')).toBe('vault/assets/a.md')

    await press('ArrowUp')
    expect(activeRow()?.getAttribute('title')).toBe('vault/assets')

    await press('End')
    const visible = flattenTree(entries, () => true)
    expect(activeRow()?.getAttribute('title')).toBe(visible[visible.length - 1].path)

    await press('Home')
    expect(activeRow()?.getAttribute('title')).toBe('vault')
  })

  it('expands/collapses with ArrowRight/ArrowLeft and walks into and back out of a folder', async () => {
    const entries = buildTree([layer('vault', ['notes/a.md'])])
    await act(async () => root.render(
      // Not expandAll: the folder starts collapsed except the layer root itself.
      <FileTree entries={entries} expandAll={false} selected={null} reveal={null} onSelect={() => {}} layerIds={new Map()} label="Sources" />,
    ))

    await press('ArrowDown')
    expect(activeRow()?.getAttribute('title')).toBe('vault/notes')
    expect(activeRow()?.getAttribute('aria-expanded')).toBe('false')

    // Collapsed dir: ArrowRight expands it in place, without moving focus.
    await press('ArrowRight')
    expect(activeRow()?.getAttribute('title')).toBe('vault/notes')
    expect(activeRow()?.getAttribute('aria-expanded')).toBe('true')

    // Expanded dir: ArrowRight now moves into the first child.
    await press('ArrowRight')
    expect(activeRow()?.getAttribute('title')).toBe('vault/notes/a.md')

    // ArrowLeft from a file row walks up to its parent directory.
    await press('ArrowLeft')
    expect(activeRow()?.getAttribute('title')).toBe('vault/notes')

    // ArrowLeft on the (still expanded) directory collapses it in place.
    await press('ArrowLeft')
    expect(activeRow()?.getAttribute('title')).toBe('vault/notes')
    expect(activeRow()?.getAttribute('aria-expanded')).toBe('false')
  })

  it('activates a file with Enter and Space', async () => {
    const entries = buildTree([layer('vault', ['a.md', 'b.md'])])
    const selected: string[] = []
    await act(async () => root.render(
      <FileTree entries={entries} expandAll selected={null} reveal={null} onSelect={(path) => selected.push(path)} layerIds={new Map()} label="Sources" />,
    ))

    await press('ArrowDown')
    expect(activeRow()?.getAttribute('title')).toBe('vault/a.md')
    await press('Enter')
    expect(selected).toEqual(['vault/a.md'])

    await press('ArrowDown')
    await press(' ')
    expect(selected).toEqual(['vault/a.md', 'vault/b.md'])
  })
})
