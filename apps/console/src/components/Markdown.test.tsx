// @vitest-environment jsdom
// Proves the rendered DOM contains no injected markup. The parser produces
// data and React creates every element, so document text lands as text nodes —
// these tests pin that end to end, in a real DOM.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Markdown } from './Markdown'

let container: HTMLDivElement
let root: Root

async function render(source: string) {
  await act(async () => root.render(<Markdown source={source} className="cc-md" />))
}

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

describe('Markdown rendering is injection-proof', () => {
  it('renders a script tag as visible text, creating no script element', async () => {
    await render('<script>alert(1)</script>')
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })

  it('renders an img/onerror payload as text, creating no img element', async () => {
    await render('<img src=x onerror="alert(1)">')
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=')
  })

  it('never emits a javascript: href', async () => {
    await render('[click](javascript:alert(1))')
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('click')
  })

  it('keeps markup inside a code fence literal', async () => {
    await render('```\n<b>bold</b>\n```')
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('pre code')?.textContent).toBe('<b>bold</b>')
  })

  it('does not let a crafted link title break out of the anchor', async () => {
    await render('[a"onmouseover="alert(1)](https://example.com)')
    const anchor = container.querySelector('a')
    expect(anchor?.getAttribute('onmouseover')).toBeNull()
    expect(anchor?.getAttribute('href')).toBe('https://example.com')
  })
})

describe('Markdown rendering produces the expected elements', () => {
  it('renders headings, emphasis and code spans', async () => {
    await render('# Title\n\nSome **bold** and `code`.')
    expect(container.querySelector('h1')?.textContent).toBe('Title')
    expect(container.querySelector('strong')?.textContent).toBe('bold')
    expect(container.querySelector('code')?.textContent).toBe('code')
  })

  it('renders task lists with disabled checkboxes', async () => {
    await render('- [x] done\n- [ ] todo')
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    expect(boxes[0].checked).toBe(true)
    expect(boxes[0].disabled).toBe(true)
    expect(boxes[1].checked).toBe(false)
  })

  it('renders tables inside a scroll container', async () => {
    await render('| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(container.querySelector('.cc-md-tablewrap table')).toBeTruthy()
    expect(container.querySelector('th')?.textContent).toBe('a')
    expect(container.querySelectorAll('td')[1]?.textContent).toBe('2')
  })

  it('marks outbound links noopener', async () => {
    await render('[a](https://example.com)')
    expect(container.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')
  })
})
