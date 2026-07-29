import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown security', () => {
  // The renderer is escape-first: a document is untrusted input, and the only
  // tags in the output are ones the renderer writes itself.
  it('renders raw HTML as text instead of markup', () => {
    const out = renderMarkdown('<script>alert(1)</script>')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('neutralizes an inline event-handler attribute', () => {
    const out = renderMarkdown('<img src=x onerror="alert(1)">')
    expect(out).not.toMatch(/<img[^>]*onerror/i)
    expect(out).toContain('&lt;img')
  })

  it('refuses javascript: links, keeping the text visible', () => {
    const out = renderMarkdown('[click me](javascript:alert(1))')
    expect(out).not.toContain('href="javascript')
    expect(out).toContain('click me')
  })

  it('refuses data: URLs in images', () => {
    const out = renderMarkdown('![x](data:text/html;base64,PHNjcmlwdD4=)')
    expect(out).not.toContain('<img')
  })

  it('allows ordinary http(s), mailto and relative links', () => {
    expect(renderMarkdown('[a](https://example.com)')).toContain('href="https://example.com"')
    expect(renderMarkdown('[a](mailto:x@y.z)')).toContain('href="mailto:x@y.z"')
    expect(renderMarkdown('[a](./notes.md)')).toContain('href="./notes.md"')
  })

  it('adds rel=noopener to outbound links', () => {
    expect(renderMarkdown('[a](https://example.com)')).toContain('rel="noopener noreferrer"')
  })

  it('does not treat markup inside a code span or fence as markup', () => {
    expect(renderMarkdown('`<b>x</b>`')).toContain('<code>&lt;b&gt;x&lt;/b&gt;</code>')
    const fenced = renderMarkdown('```html\n<script>bad()</script>\n```')
    expect(fenced).toContain('<pre><code class="language-html">')
    expect(fenced).toContain('&lt;script&gt;')
    expect(fenced).not.toContain('<script>')
  })
})

describe('renderMarkdown formatting', () => {
  it('renders headings, dropping OKF heading attributes', () => {
    expect(renderMarkdown('## Engine {#engine updated=2026-04-01}')).toBe('<h2>Engine</h2>')
  })

  it('renders emphasis, strong and strikethrough', () => {
    expect(renderMarkdown('**bold** and *italic* and ~~gone~~'))
      .toContain('<strong>bold</strong>')
    expect(renderMarkdown('*italic*')).toContain('<em>italic</em>')
    expect(renderMarkdown('~~gone~~')).toContain('<del>gone</del>')
  })

  it('renders bullet, numbered and task lists', () => {
    expect(renderMarkdown('- one\n- two')).toBe('<ul>\n<li>one</li>\n<li>two</li>\n</ul>')
    expect(renderMarkdown('1. one')).toContain('<ol>')
    const task = renderMarkdown('- [x] done\n- [ ] todo')
    expect(task).toContain('checked')
    expect(task).toContain('todo')
  })

  it('renders tables inside a horizontally scrollable wrapper', () => {
    const out = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(out).toContain('cc-md-tablewrap')
    expect(out).toContain('<th>a</th>')
    expect(out).toContain('<td>2</td>')
  })

  it('renders blockquotes and horizontal rules', () => {
    expect(renderMarkdown('> quoted')).toBe('<blockquote>quoted</blockquote>')
    expect(renderMarkdown('---')).toBe('<hr />')
  })

  it('renders OKF wiki links as marks, not broken text', () => {
    expect(renderMarkdown('See [[decisions/primary-db]]')).toContain('cc-md-wikilink')
  })

  it('joins wrapped lines into one paragraph', () => {
    expect(renderMarkdown('one\ntwo')).toBe('<p>one two</p>')
  })

  it('handles empty input without throwing', () => {
    expect(renderMarkdown('')).toBe('')
  })
})
