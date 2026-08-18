import { describe, expect, it } from 'vitest'
import { HEX_VARS } from './theme'
import { ccTokens, declarationsFor } from './themes/css-blocks'
import { BLOCKS, LIGHT_SELECTOR } from './themes/gates'

// The console writes many inline styles as literal hex colors and relies on
// `css()` to remap them onto `--cc-*` variables through HEX_VARS. A hex that
// is not registered renders correctly in light mode and silently stops
// adapting in dark — the CLAUDE.md gotcha this suite turns into a failure.
//
// Sources are read through Vite's raw imports rather than node:fs: the console
// has no @types/node (it is a browser package), and this keeps it that way.

/** Every TS/TSX source under src/, keyed by path relative to this file. */
const ALL_SOURCES = import.meta.glob('./**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/** Files the walk skips: tests, generated bundles, the registry itself, and the palette files PR 8 adds. */
const SKIP_PATH = (path: string) =>
  /\.test\.[cm]?tsx?$/.test(path) || path.startsWith('./generated/') || path.startsWith('./themes/') || path === './theme.ts'

function sourceFiles(): Array<[path: string, source: string]> {
  return Object.entries(ALL_SOURCES).filter(([path]) => !SKIP_PATH(path)).sort(([a], [b]) => a.localeCompare(b))
}

/** Keywords after which a `/` starts a regex literal rather than a division. */
const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof'])

/**
 * The contents of every string literal in a TS/TSX source: `'…'`, `"…"`, and
 * template literals (each quasi separately, with `${…}` recursed so a nested
 * literal is seen too). Comments and regex literals are skipped — a comment
 * may say "see #136" or "was #17241f", a regex may contain a quote or a
 * backtick, and neither is a color in a style.
 *
 * This is a heuristic lexer, not a parser, so the shapes it leans on are
 * spelled out: a `/` opens a regex when the previous significant token is a
 * punctuator that cannot end an expression (`( , = : [ ! & | ? { } ;` and the
 * arithmetic operators) or one of REGEX_AFTER_KEYWORD, and never when it
 * closes a JSX tag (`</` or `/>`); `//` opens a comment except directly after
 * `:` (a URL in JSX text); a quote directly after an identifier character,
 * `}` or `)` is prose (`we'll`, `{name}'s` in JSX text), not a string. JSX text is otherwise read as
 * code, which is fine because it cannot carry a style. The
 * "cross-check" test below asserts the lexer never sees fewer hexes than a
 * plain grep of comment-free lines, so any desync fails loudly rather than
 * hiding a hex.
 */
export function stringLiterals(source: string): string[] {
  const out: string[] = []
  const isIdent = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_$]/.test(ch)

  /** Whether a `/` at index i begins a regex literal, judged by what precedes it. */
  function opensRegex(i: number): boolean {
    const next = source[i + 1]
    if (next === '/' || next === '*' || next === '>') return false // comment, or JSX `/>`
    let j = i - 1
    while (j >= 0 && /\s/.test(source[j])) j--
    if (j < 0) return true
    const prev = source[j]
    if (prev === '<') return false // JSX `</tag>`
    if (/[(,=:[!&|?{};+\-*%~^]/.test(prev)) return true
    if (isIdent(prev)) {
      let k = j
      while (k >= 0 && isIdent(source[k])) k--
      return REGEX_AFTER_KEYWORD.has(source.slice(k + 1, j + 1))
    }
    return false
  }

  /** Skip a regex literal starting at i (the opening `/`); returns the index after its flags. */
  function skipRegex(i: number): number {
    let j = i + 1
    let inClass = false
    while (j < source.length && source[j] !== '\n') {
      const c = source[j]
      if (c === '\\') { j += 2; continue }
      if (inClass) { if (c === ']') inClass = false } else if (c === '[') inClass = true
      else if (c === '/') { j++; break }
      j++
    }
    while (j < source.length && /[a-z]/.test(source[j])) j++
    return j
  }

  function scanCode(i: number, untilBrace: boolean): number {
    let depth = 0
    while (i < source.length) {
      const c = source[i]
      const next = source[i + 1]
      if (c === '/' && next === '/' && source[i - 1] !== ':') {
        const nl = source.indexOf('\n', i)
        if (nl === -1) return source.length
        i = nl + 1
        continue
      }
      if (c === '/' && next === '*') {
        const end = source.indexOf('*/', i + 2)
        if (end === -1) return source.length
        i = end + 2
        continue
      }
      if (c === '/' && opensRegex(i)) { i = skipRegex(i); continue }
      if (c === '\'' || c === '"') {
        // Prose, not a string opener: `we'll`, and `{name}'s` / `{f()}'s` in JSX
        // text — no TS expression puts a quote straight after an identifier,
        // `}` or `)` without an operator or comma between.
        if (isIdent(source[i - 1]) || source[i - 1] === '}' || source[i - 1] === ')') { i++; continue }
        let j = i + 1
        let buf = ''
        while (j < source.length && source[j] !== c && source[j] !== '\n') {
          if (source[j] === '\\') { buf += source[j] + (source[j + 1] ?? ''); j += 2 } else buf += source[j++]
        }
        out.push(buf)
        i = j + 1
        continue
      }
      if (c === '`') { i = scanTemplate(i + 1); continue }
      if (untilBrace) {
        if (c === '{') depth++
        else if (c === '}') { if (depth === 0) return i + 1; depth-- }
      }
      i++
    }
    return source.length
  }

  function scanTemplate(i: number): number {
    let buf = ''
    while (i < source.length) {
      const c = source[i]
      if (c === '\\') { buf += c + (source[i + 1] ?? ''); i += 2; continue }
      if (c === '`') { out.push(buf); return i + 1 }
      if (c === '$' && source[i + 1] === '{') { out.push(buf); buf = ''; i = scanCode(i + 2, true); continue }
      buf += c
      i++
    }
    out.push(buf)
    return source.length
  }

  scanCode(0, false)
  return out
}

const HEX_LITERAL = /#([0-9a-fA-F]{3,8})\b/g
const SIX_HEX = /#[0-9a-fA-F]{6}\b/g

interface HexHit { file: string; hex: string }

function inlineHexes(): { six: HexHit[]; other: HexHit[]; seenByFile: Map<string, Set<string>> } {
  const six: HexHit[] = []
  const other: HexHit[] = []
  const seenByFile = new Map<string, Set<string>>()
  for (const [file, source] of sourceFiles()) {
    const seen = new Set<string>()
    for (const literal of stringLiterals(source)) {
      for (const m of literal.matchAll(HEX_LITERAL)) {
        const digits = m[1]
        // `#dead`-style false positives are possible in principle, but every
        // hit here is a color: 6 digits is the only shape `css()` remaps.
        ;(digits.length === 6 ? six : other).push({ file, hex: `#${digits}` })
        if (digits.length === 6) seen.add(`#${digits}`.toUpperCase())
      }
    }
    seenByFile.set(file, seen)
  }
  return { six, other, seenByFile }
}

describe('HEX_VARS covers every inline hex color', () => {
  const { six, other, seenByFile } = inlineHexes()

  it('walks the real source tree (the glob is not silently empty)', () => {
    const files = sourceFiles().map(([path]) => path)
    expect(files).toContain('./views/Canvas.tsx')
    expect(files).toContain('./components/ConceptDetail.tsx')
    expect(files.some((path) => path.includes('.test.'))).toBe(false)
    expect(six.length).toBeGreaterThan(20)
  })

  it('cross-check: the lexer sees every six-digit hex a plain grep of comment-free lines sees', () => {
    // A lexer desync (regex, template, JSX quirk) would *hide* hexes, and a
    // hidden hex is a silently passing gate. So a naive line grep — skipping
    // only lines that could hold a comment — must never find more than the
    // lexer did. Any line here means the lexer needs a new rule, not the gate a new exception.
    const missed: string[] = []
    for (const [file, source] of sourceFiles()) {
      const seen = seenByFile.get(file) ?? new Set<string>()
      source.split('\n').forEach((line, i) => {
        if (line.includes('//') || line.includes('/*') || line.includes('*/') || /^\s*\*/.test(line)) return
        for (const m of line.matchAll(SIX_HEX)) {
          if (!seen.has(m[0].toUpperCase())) missed.push(`${file}:${i + 1}: ${m[0]}`)
        }
      })
    }
    expect(missed).toEqual([])
  })

  it('every six-digit inline hex is a HEX_VARS key', () => {
    const unregistered = six
      .filter(({ hex }) => !(hex.toUpperCase() in HEX_VARS))
      .map(({ file, hex }) => `${file}: ${hex}`)
    expect(unregistered, 'add these to HEX_VARS in theme.ts or use a C.* token').toEqual([])
  })

  it('no inline hex uses a shape css() cannot remap (3, 4 or 8 digits)', () => {
    expect(
      other.map(({ file, hex }) => `${file}: ${hex}`),
      'a color must be written as six digits and registered in HEX_VARS; if this is an anchor or issue reference in a UI string, teach stringLiterals() to tell it apart rather than allowlisting it here',
    ).toEqual([])
  })

  it('every HEX_VARS value names a --cc-* token declared in styles.css :root', () => {
    const declared = ccTokens(declarationsFor(BLOCKS, LIGHT_SELECTOR))
    const missing = Object.entries(HEX_VARS)
      .filter(([, token]) => !declared.has(token))
      .map(([hex, token]) => `${hex} → ${token}`)
    expect(missing).toEqual([])
  })

  it('HEX_VARS keys are upper-case six-digit hexes (the lookup upper-cases before matching)', () => {
    for (const key of Object.keys(HEX_VARS)) expect(key).toMatch(/^#[0-9A-F]{6}$/)
  })
})

describe('stringLiterals lexer', () => {
  it('reads single, double and template literals and skips comments', () => {
    const src = [
      "const a = 'x #111111'; // not #222222",
      '/* nor #333333 */ const b = "y #444444"',
      'const c = `z #555555 ${d("#666666")} w`',
      "<p>we'll keep going</p>",
      "const e = '#777777'",
    ].join('\n')
    const joined = stringLiterals(src).join('|')
    for (const hex of ['#111111', '#444444', '#555555', '#666666', '#777777']) expect(joined).toContain(hex)
    for (const hex of ['#222222', '#333333']) expect(joined).not.toContain(hex)
  })

  it('does not let a regex literal, a JSX URL or a JSX apostrophe desynchronise the scan', () => {
    const src = [
      "const re = /'/; const s = css('color:#111111')",
      'const fence = /^\\s{0,3}(```|~~~)(.*)$/; const t = css(`color:#222222`)',
      "const ratio = a / b; const u = css('color:#333333')",
      "const q = x ? /a[/]b/g : /c/; const v = css('color:#444444')",
      "<a>https://example.test/x</a><b style={css('color:#555555')} />",
      "<p>{name}'s file</p><i style={css('color:#666666')} />",
      "<Foo bar={x} /><span style={css('color:#777777')} />",
      "return /y/.test(z) ? css('color:#888888') : null",
    ].join('\n')
    const joined = stringLiterals(src).join('|')
    for (const hex of ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777', '#888888']) {
      expect(joined, hex).toContain(hex)
    }
  })
})
