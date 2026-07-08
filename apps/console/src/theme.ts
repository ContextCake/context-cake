// Design tokens for ContextCake Console.
//
// Every color is a CSS variable so the whole app themes (light "paper" ⇄ dark
// "canvas") by flipping `data-theme` on <html>. The concrete values live in
// styles.css. `C` holds the variable references; `css()` additionally maps any
// literal hex still written inline (there are many, ported 1:1 from the design)
// onto the same variables, so nothing has to be hand-converted.
export const C = {
  page: 'var(--cc-page)', surface: 'var(--cc-surface)', raised: 'var(--cc-raised)',
  line: 'var(--cc-line)', lineStrong: 'var(--cc-line-strong)', lineSoft: 'var(--cc-line-soft)',
  track: 'var(--cc-track)', neutralFill: 'var(--cc-neutral-fill)',
  ink: 'var(--cc-ink)', body: 'var(--cc-body)', caption: 'var(--cc-caption)', faint: 'var(--cc-faint)',
  blueFill: 'var(--cc-blue-fill)', blueFill2: 'var(--cc-blue-fill2)', blueFill3: 'var(--cc-blue-fill3)',
  blueStroke: 'var(--cc-blue-stroke)', blueStrokeE: 'var(--cc-blue-stroke-e)',
  blueText: 'var(--cc-blue-text)', blueText2: 'var(--cc-blue-text2)', blueSoft: 'var(--cc-blue-soft)',
  tealFill: 'var(--cc-teal-fill)', tealFill2: 'var(--cc-teal-fill2)', tealStroke: 'var(--cc-teal-stroke)',
  tealStrokeE: 'var(--cc-teal-stroke-e)', tealText: 'var(--cc-teal-text)', onTeal: 'var(--cc-on-teal)',
  amberFill: 'var(--cc-amber-fill)', amberFill2: 'var(--cc-amber-fill2)', amberStroke: 'var(--cc-amber-stroke)',
  amberStrokeE: 'var(--cc-amber-stroke-e)', amberText: 'var(--cc-amber-text)', amberText2: 'var(--cc-amber-text2)',
  amberSoft: 'var(--cc-amber-soft)',
} as const

export const MONO = "'JetBrains Mono', ui-monospace, monospace"

export type LayerId = 'company' | 'team' | 'personal'
export type RouteId = 'review_required' | 'team_candidate' | 'ignore'

export interface LayerColors {
  fill: string; stroke: string; strokeE: string; text: string; text2: string
}
// Provenance semantics: each layer gets its own hue, matching the brand
// trio used on the site and playground (company blue / team sage-teal /
// personal amber). The emphasis stroke on each ramp is the exact canonical
// hex; fill/stroke/text tiers are tinted per theme for contrast.
export function lc(id: LayerId): LayerColors {
  if (id === 'company') return { fill: C.blueFill, stroke: C.blueSoft, strokeE: C.blueStrokeE, text: C.blueText, text2: C.blueText2 }
  if (id === 'team') return { fill: C.tealFill, stroke: C.tealStroke, strokeE: C.tealStrokeE, text: C.tealText, text2: C.tealText }
  return { fill: C.amberFill, stroke: C.amberStroke, strokeE: C.amberStrokeE, text: C.amberText, text2: C.amberText2 }
}

export interface RouteColors { fill: string; stroke: string; text: string; label: string; accent: string }
export function rc(route: RouteId): RouteColors {
  if (route === 'review_required') return { fill: C.amberFill, stroke: C.amberStroke, text: C.amberText, label: 'Review', accent: C.amberStroke }
  if (route === 'team_candidate') return { fill: C.tealFill, stroke: C.tealStroke, text: C.tealText, label: 'Store', accent: C.tealStroke }
  return { fill: C.neutralFill, stroke: C.lineStrong, text: C.caption, label: 'Discard', accent: C.lineStrong }
}

export function badgeStyle(route: RouteId): React.CSSProperties {
  const r = rc(route)
  return css(`display:inline-flex; align-items:center; font-family:${MONO}; font-size:10px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase; padding:3px 9px; border-radius:999px; background:${r.fill}; color:${r.text}; border:1px solid ${r.stroke}; flex:0 0 auto;`)
}

export function conceptTypeStyle(t: string): React.CSSProperties {
  const m: Record<string, string> = { system: C.blueStroke, runbook: C.tealStroke, interface: C.blueStrokeE, decision: C.amberStrokeE }
  const col = m[t] || C.caption
  return css(`display:inline-flex; align-items:center; font-family:${MONO}; font-size:9.5px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; padding:2px 8px; border-radius:6px; color:${col}; border:1px solid ${col}; background:${C.raised};`)
}

// Literal hex → CSS variable. Lets the ported inline styles theme unchanged.
const HEX_VARS: Record<string, string> = {
  '#F1F0EA': '--cc-page', '#FBFAF6': '--cc-surface', '#FFFFFF': '--cc-raised',
  '#D8D6CC': '--cc-line', '#C3C1B8': '--cc-line-strong',
  '#E4E1D6': '--cc-line-soft', '#EDEAE0': '--cc-line-soft', '#EAE7DD': '--cc-line-soft',
  '#ECEAE0': '--cc-track', '#F1EFE7': '--cc-neutral-fill',
  '#1A1915': '--cc-ink', '#3A3934': '--cc-body', '#57564F': '--cc-caption', '#8A8A82': '--cc-faint',
  '#EAF3FC': '--cc-blue-fill', '#D9EAFB': '--cc-blue-fill2', '#C6DEF6': '--cc-blue-fill3',
  '#3D7AB8': '--cc-blue-stroke', '#2F6DA8': '--cc-blue-stroke-e', '#0C447C': '--cc-blue-text',
  '#3D6E9E': '--cc-blue-text2', '#8FB8DE': '--cc-blue-soft',
  '#EAF7F5': '--cc-teal-fill', '#D7F0EC': '--cc-teal-fill2', '#2C8A82': '--cc-teal-stroke',
  '#1E6B64': '--cc-teal-stroke-e', '#134F49': '--cc-teal-text', '#BEE7E1': '--cc-teal-badge-bd',
  '#FBF0DD': '--cc-amber-fill', '#F3E3C4': '--cc-amber-fill2', '#D69A3F': '--cc-amber-stroke',
  '#C77D2A': '--cc-amber-stroke-e', '#5A3D12': '--cc-amber-text', '#7A5A28': '--cc-amber-text2',
  '#E8C88C': '--cc-amber-soft',
}
const HEX_RE = /#[0-9a-fA-F]{6}/g

/**
 * Parse a semicolon-delimited CSS declaration string into a React style object,
 * remapping known literal hex colors to their theme variables along the way.
 */
export function css(decl: string): React.CSSProperties {
  const mapped = decl
    .replace(HEX_RE, (h) => { const v = HEX_VARS[h.toUpperCase()]; return v ? `var(${v})` : h })
    .replace('rgba(241,240,234,0.82)', 'var(--cc-header-bg)')
    .replace(/rgba\(26,25,21,0\.28\)/g, 'var(--cc-scrim)')
  const out: Record<string, string> = {}
  for (const part of mapped.split(';')) {
    const i = part.indexOf(':')
    if (i === -1) continue
    const rawKey = part.slice(0, i).trim()
    const val = part.slice(i + 1).trim()
    if (!rawKey || !val) continue
    const key = rawKey.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    out[key] = val
  }
  // Several cards set the `border` shorthand *and* a side-specific accent
  // (e.g. borderLeft). React warns that mixing shorthand + longhand on one
  // element has undefined apply-order across re-renders, which can drop the
  // accent stripe. Expand the shorthand into the sides not spoken for.
  const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const
  if (out.border && SIDES.some((s) => out[`border${s}`] != null)) {
    const shorthand = out.border
    delete out.border
    for (const s of SIDES) if (out[`border${s}`] == null) out[`border${s}`] = shorthand
  }
  return out as React.CSSProperties
}
