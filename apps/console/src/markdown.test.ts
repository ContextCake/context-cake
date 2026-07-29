import { describe, expect, it } from 'vitest'
import { parseMarkdown, parseInline, safeUrl, type Inline } from './markdown'

/** Flatten an inline tree to its visible text, for concise assertions. */
function textOf(nodes: Inline[]): string {
  return nodes.map((n) => {
    switch (n.type) {
      case 'text': return n.value
      case 'code': return n.value
      case 'wikilink': return n.value
      case 'image': return n.alt
      default: return 'children' in n ? textOf(n.children) : ''
    }
  }).join('')
}

describe('URL filtering', () => {
  // The parser emits data, so injection is impossible by construction; a
  // javascript: href would still be dangerous inside a real anchor, so URLs
  // are the one thing filtered here.
  it('rejects javascript: and data: URLs', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull()
    expect(safeUrl('JaVaScRiPt:alert(1)')).toBeNull()
    expect(safeUrl('data:text/html;base64,PHNjcmlwdD4=')).toBeNull()
    expect(safeUrl('vbscript:msgbox')).toBeNull()
  })

  it('allows ordinary navigational URLs', () => {
    expect(safeUrl('https://example.com')).toBe('https://example.com')
    expect(safeUrl('mailto:x@y.z')).toBe('mailto:x@y.z')
    expect(safeUrl('./notes.md')).toBe('./notes.md')
    expect(safeUrl('#anchor')).toBe('#anchor')
  })

  it('keeps a rejected link visible as text rather than dropping content', () => {
    const nodes = parseInline('[click me](javascript:alert(1))')
    expect(nodes.every((n) => n.type !== 'link')).toBe(true)
    expect(textOf(nodes)).toContain('click me')
  })

  it('keeps a rejected image visible as text', () => {
    const nodes = parseInline('![alt](data:text/html,x)')
    expect(nodes.every((n) => n.type !== 'image')).toBe(true)
  })
})

describe('parseInline', () => {
  it('treats raw HTML as ordinary text, never markup', () => {
    const nodes = parseInline('<script>alert(1)</script>')
    expect(nodes).toEqual([{ type: 'text', value: '<script>alert(1)</script>' }])
  })

  it('parses code spans without re-scanning their contents', () => {
    expect(parseInline('`<b>x</b>`')).toEqual([{ type: 'code', value: '<b>x</b>' }])
    // Markup inside a code span stays literal.
    expect(parseInline('`**not bold**`')).toEqual([{ type: 'code', value: '**not bold**' }])
  })

  it('does not confuse literal text with an internal placeholder', () => {
    // The previous string-based renderer used ` CODE0 ` markers, which a
    // document could collide with. There are no placeholders now.
    const nodes = parseInline('`x` and the CODE0 constant')
    expect(textOf(nodes)).toBe('x and the CODE0 constant')
  })

  it('parses emphasis, strong and strikethrough', () => {
    expect(parseInline('**bold**')).toEqual([{ type: 'strong', children: [{ type: 'text', value: 'bold' }] }])
    expect(parseInline('*italic*')).toEqual([{ type: 'em', children: [{ type: 'text', value: 'italic' }] }])
    expect(parseInline('~~gone~~')).toEqual([{ type: 'del', children: [{ type: 'text', value: 'gone' }] }])
  })

  it('parses nested inline markup without re-scanning from the start', () => {
    // Regression: the scanner regex was module-level and global, so a
    // recursive call (emphasis/link contents) reset its lastIndex and the
    // outer loop restarted forever. This input hangs on that bug.
    const nodes = parseInline('**bold with *nested* emphasis** and [a **link**](https://example.com)')
    expect(textOf(nodes)).toBe('bold with nested emphasis and a link')
    expect(nodes.some((n) => n.type === 'link')).toBe(true)
  })

  it('parses links and OKF wiki links', () => {
    const [link] = parseInline('[a](https://example.com)')
    expect(link).toMatchObject({ type: 'link', href: 'https://example.com' })
    expect(parseInline('[[decisions/primary-db]]')).toEqual([{ type: 'wikilink', value: 'decisions/primary-db' }])
  })
})

describe('parseMarkdown', () => {
  it('parses headings and drops OKF heading attributes', () => {
    expect(parseMarkdown('## Engine {#engine updated=2026-04-01}')).toEqual([
      { type: 'heading', level: 2, content: [{ type: 'text', value: 'Engine' }] },
    ])
  })

  it('captures fenced code verbatim, including markup', () => {
    const [block] = parseMarkdown('```html\n<script>bad()</script>\n```')
    expect(block).toEqual({ type: 'code', lang: 'html', text: '<script>bad()</script>' })
  })

  it('parses bullet, ordered and task lists', () => {
    const [bullets] = parseMarkdown('- one\n- two')
    expect(bullets).toMatchObject({ type: 'list', ordered: false })
    expect(parseMarkdown('1. one')[0]).toMatchObject({ type: 'list', ordered: true })
    const [tasks] = parseMarkdown('- [x] done\n- [ ] todo')
    expect(tasks).toMatchObject({
      type: 'list',
      items: [{ task: true, checked: true }, { task: true, checked: false }],
    })
  })

  it('parses tables into head and rows', () => {
    const [table] = parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(table).toMatchObject({ type: 'table' })
    if (table.type !== 'table') throw new Error('expected a table')
    expect(table.head.map(textOf)).toEqual(['a', 'b'])
    expect(table.rows[0].map(textOf)).toEqual(['1', '2'])
  })

  it('parses quotes and rules', () => {
    expect(parseMarkdown('> quoted')[0]).toMatchObject({ type: 'quote' })
    expect(parseMarkdown('---')).toEqual([{ type: 'rule' }])
  })

  it('joins wrapped lines into one paragraph', () => {
    const [para] = parseMarkdown('one\ntwo')
    expect(para).toMatchObject({ type: 'paragraph' })
    if (para.type !== 'paragraph') throw new Error('expected a paragraph')
    expect(textOf(para.content)).toBe('one two')
  })

  it('handles empty input', () => {
    expect(parseMarkdown('')).toEqual([])
  })

  it('parses a long table divider quickly (no catastrophic backtracking)', () => {
    // The obvious divider regex backtracks polynomially on input like this.
    const line = `| ${'-'.repeat(4000)}`
    const started = Date.now()
    parseMarkdown(`| a |\n${line}\n`)
    expect(Date.now() - started).toBeLessThan(500)
  })
})
