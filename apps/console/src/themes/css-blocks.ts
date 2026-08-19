// A deliberately small reading of a stylesheet, for the theme gates: strip
// comments, then hand back every innermost `selector { declarations }` block.
// Nesting is not modelled — a rule inside `@media` comes back with its own
// selector and the at-rule is simply not a block — which is all the token
// tests need and keeps this dependency-free like the rest of the console.
// (`tokens.test.ts` guards that the stylesheet has no CSS nesting, the one
// shape this flat reading would silently mis-bucket.)

export interface CssBlock {
  /** The selector text as written, whitespace collapsed. */
  selector: string
  /** `selector` split on top-level commas, so a rule can be looked up by any member of its list. */
  selectors: string[]
  /** The raw declaration text between the braces. */
  body: string
  /** Property → value, last declaration wins, `--custom-properties` included. */
  declarations: Map<string, string>
  /** Every declaration in source order, duplicates kept (a literal followed by a token fallback is still a literal). */
  declarationList: Array<[prop: string, value: string]>
}

/** Comments become the same number of newlines, so line numbers in reports still point at the source. */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
}

/** Every innermost `{ … }` block, in source order, with comments removed. */
export function parseCssBlocks(css: string): CssBlock[] {
  const source = stripCssComments(css)
  const blocks: CssBlock[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const selector = normalizeSelector(m[1])
    if (!selector) continue
    const declarationList = parseDeclarationList(m[2])
    blocks.push({
      selector,
      selectors: splitSelectorList(selector),
      body: m[2],
      declarations: new Map(declarationList),
      declarationList,
    })
  }
  return blocks
}

/** Collapse whitespace so `:root[data-theme="dark"]` matches however it was written. */
export function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, ' ').trim()
}

/** Split a selector list on commas that are not inside `(...)` or `[...]`. */
export function splitSelectorList(selector: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === ',' && depth === 0) { out.push(selector.slice(start, i)); start = i + 1 }
  }
  out.push(selector.slice(start))
  return out.map(normalizeSelector).filter(Boolean)
}

export function parseDeclarationList(body: string): Array<[prop: string, value: string]> {
  const out: Array<[string, string]> = []
  for (const part of body.split(';')) {
    const i = part.indexOf(':')
    if (i === -1) continue
    const prop = part.slice(0, i).trim()
    const value = part.slice(i + 1).trim()
    if (prop && value) out.push([prop, value])
  }
  return out
}

export function parseDeclarations(body: string): Map<string, string> {
  return new Map(parseDeclarationList(body))
}

/**
 * The merged declarations of every block whose selector list contains
 * `selector` (a stylesheet may open `:root {` more than once, or list it with
 * other selectors; later wins as in CSS).
 */
export function declarationsFor(blocks: readonly CssBlock[], selector: string): Map<string, string> {
  const want = normalizeSelector(selector)
  const out = new Map<string, string>()
  for (const block of blocks) {
    if (!block.selectors.includes(want)) continue
    for (const [prop, value] of block.declarations) out.set(prop, value)
  }
  return out
}

/** Only the `--cc-*` custom properties out of a declaration map. */
export function ccTokens(declarations: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>()
  for (const [prop, value] of declarations) if (prop.startsWith('--cc-')) out.set(prop, value)
  return out
}
