// Pure color math for the theme gates: parse the color syntaxes styles.css
// uses, composite translucent tokens over their backdrops, and score WCAG
// contrast. No DOM, no dependencies — the tests read styles.css and hand the
// declarations in; a palette picker could equally score a swatch at runtime.

export interface Rgba { r: number; g: number; b: number; a: number }

const NAMED: Record<string, Rgba> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
}

/**
 * `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` (comma or space
 * separated, alpha as a number or a percentage), and the three keywords the
 * stylesheet relies on. Anything else — including `var()` and `color-mix()`,
 * which need declarations to resolve — is `null`.
 */
export function parseColor(input: string): Rgba | null {
  const value = input.trim().toLowerCase()
  if (value in NAMED) return { ...NAMED[value] }
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value)
  if (hex) {
    let digits = hex[1]
    if (digits.length <= 4) digits = [...digits].map((d) => d + d).join('')
    const n = (i: number) => parseInt(digits.slice(i, i + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: digits.length === 8 ? n(6) / 255 : 1 }
  }
  const fn = /^rgba?\((.*)\)$/.exec(value)
  if (fn) {
    const parts = fn[1].split(/\s*[,/]\s*|\s+/).filter(Boolean)
    if (parts.length !== 3 && parts.length !== 4) return null
    const channel = (s: string) => (s.endsWith('%') ? (parseFloat(s) / 100) * 255 : parseFloat(s))
    const alpha = (s: string) => (s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s))
    const [r, g, b] = parts.slice(0, 3).map(channel)
    const a = parts.length === 4 ? alpha(parts[3]) : 1
    if ([r, g, b, a].some((x) => Number.isNaN(x))) return null
    return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: clamp01(a) }
  }
  return null
}

const clamp255 = (x: number) => Math.min(255, Math.max(0, x))
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/** Source-over: `fg` painted onto `backdrop`. */
export function over(fg: Rgba, backdrop: Rgba): Rgba {
  const a = fg.a + backdrop.a * (1 - fg.a)
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
  const mix = (f: number, b: number) => (f * fg.a + b * backdrop.a * (1 - fg.a)) / a
  return { r: mix(fg.r, backdrop.r), g: mix(fg.g, backdrop.g), b: mix(fg.b, backdrop.b), a }
}

/** WCAG 2.x relative luminance of an (assumed opaque) sRGB color. */
export function luminance(color: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(color.r) + 0.7152 * lin(color.g) + 0.0722 * lin(color.b)
}

/** WCAG contrast ratio, 1..21. Both colors are treated as opaque — composite first. */
export function contrast(a: Rgba, b: Rgba): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Token name → raw declared value, e.g. `--cc-page` → `#F4F3EA`. */
export type Declarations = ReadonlyMap<string, string>

/**
 * Resolve a token to a color, following `var(--x)` (with an optional
 * fallback) and the one `color-mix()` grammar the stylesheet uses —
 * `color-mix(in srgb, A [p%], B [p%])`, mixed premultiplied in sRGB exactly
 * as browsers do, so `color-mix(in srgb, X 12%, transparent)` is X at 12%
 * alpha. `backdropChain` lists the surfaces the token is painted over,
 * nearest first; the result is composited over each in turn, so a
 * translucent fill lands as the opaque color a reader actually sees.
 */
export function resolveToken(name: string, decls: Declarations, backdropChain: readonly string[] = []): Rgba {
  let color = resolveValue(name, decls, new Set())
  for (const backdrop of backdropChain) color = over(color, resolveValue(backdrop, decls, new Set()))
  return color
}

function resolveValue(name: string, decls: Declarations, seen: Set<string>): Rgba {
  if (seen.has(name)) throw new Error(`Cycle resolving ${name} via ${[...seen].join(' -> ')}`)
  const raw = decls.get(name)
  if (raw === undefined) throw new Error(`Token ${name} is not declared`)
  return evaluate(raw, decls, new Set([...seen, name]))
}

function evaluate(expression: string, decls: Declarations, seen: Set<string>): Rgba {
  const value = expression.trim()
  const direct = parseColor(value)
  if (direct) return direct
  const ref = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/s.exec(value)
  if (ref) {
    if (decls.has(ref[1]) || ref[2] === undefined) return resolveValue(ref[1], decls, seen)
    return evaluate(ref[2], decls, seen)
  }
  const mix = /^color-mix\(\s*in\s+srgb\s*,(.+)\)$/s.exec(value)
  if (mix) {
    const args = splitTopLevel(mix[1])
    if (args.length !== 2) throw new Error(`Unsupported color-mix arity in "${value}"`)
    const [a, b] = args.map((arg) => splitMixArg(arg))
    for (const pct of [a.pct, b.pct]) {
      if (pct !== null && (pct < 0 || pct > 100)) throw new Error(`color-mix percentage out of range in "${value}"`)
    }
    // One percentage implies the other; neither means an even mix.
    const pa = a.pct ?? (b.pct === null ? 50 : 100 - b.pct)
    const pb = b.pct ?? 100 - pa
    const total = pa + pb
    if (total <= 0) throw new Error(`color-mix percentages sum to zero in "${value}"`)
    // Normalise so partial percentages behave like the spec's alpha multiplier.
    const wa = pa / total
    const wb = pb / total
    const alphaScale = total > 100 ? 1 : total / 100
    const ca = evaluate(a.color, decls, seen)
    const cb = evaluate(b.color, decls, seen)
    const alpha = (wa * ca.a + wb * cb.a) * alphaScale
    if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 }
    const channel = (x: number, y: number) => (wa * ca.a * x + wb * cb.a * y) / (wa * ca.a + wb * cb.a)
    return { r: channel(ca.r, cb.r), g: channel(ca.g, cb.g), b: channel(ca.b, cb.b), a: alpha }
  }
  throw new Error(`Cannot resolve "${value}" as a color`)
}

/** `A 12%` → { color: 'A', pct: 12 }; a trailing percentage is optional. */
function splitMixArg(arg: string): { color: string; pct: number | null } {
  const m = /^(.*?)\s+(-?[\d.]+)%$/s.exec(arg.trim())
  return m ? { color: m[1].trim(), pct: parseFloat(m[2]) } : { color: arg.trim(), pct: null }
}

/** Split on commas that are not inside parentheses. */
function splitTopLevel(input: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) { out.push(input.slice(start, i)); start = i + 1 }
  }
  out.push(input.slice(start))
  return out.map((s) => s.trim()).filter(Boolean)
}
