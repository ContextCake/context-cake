// Cascade order: the console's one source of truth for "which layer wins".
//
// The engine keeps precedence as an integer (`level`, higher wins — see
// resolver.mjs) and that number stays put: flipping it would silently invert
// every existing manifest. What the console shows instead is a POSITION —
// #1..N, 1 wins — and everything here derives from the same distinct-level
// list so the rank a row shows, the lane it renders in, and the order the
// reorder API is sent can never disagree with one another.
//
// Pure and dependency-free on purpose: views, the wizard, the store and the
// tests all import from here, and the Sources suite mocks `../api` down to
// `apiFetch`, so this must not live there.
import type { LayerId } from './theme'

const LAYER_IDS: LayerId[] = ['company', 'team', 'personal']
export const isLayerId = (s: string): s is LayerId => (LAYER_IDS as string[]).includes(s)

/**
 * Rank-based bucket assignment for one resolve pass. `LayerId` stays a
 * closed, three-value union — styling in ~8 files depends on it — so an
 * arbitrary manifest level still needs an honest lane without widening that
 * type. The highest level actually present becomes 'personal', the next
 * 'team', and everything else 'company'. That fixes the fixed-threshold bug
 * where a lone level-1 source (nothing above it) read as 'company' with the
 * Team lane sitting empty: ranked among the levels that actually exist, level
 * 1 is the *second* highest and lands in 'team'.
 *
 * Must be computed once per resolve pass from every source in play (not per
 * concept or per record) and threaded through every adapter — computing it
 * from a narrower slice would bucket the same source differently depending
 * on what happened to touch it.
 */
export type LevelBuckets = ReadonlyMap<number, LayerId>

/** The distinct levels present, highest first — the list ranks and lanes both come from. */
export function distinctLevelsDesc(levels: Iterable<number>): number[] {
  return [...new Set(levels)].sort((a, b) => b - a)
}

export function computeLevelBuckets(levels: Iterable<number>): LevelBuckets {
  const buckets = new Map<number, LayerId>()
  distinctLevelsDesc(levels).forEach((level, rank) => buckets.set(level, rank === 0 ? 'personal' : rank === 1 ? 'team' : 'company'))
  return buckets
}

/**
 * The buckets for a resolve pass, from the sources that are actually IN the
 * cascade. A quarantined manifest entry arrives with a level too (whatever
 * the file said — 9 is as likely as 0) but contributes nothing and holds no
 * position; ranking it would shift every real source's lane. This is the one
 * place both the graph adapters (`adaptSources`, the store's `readAll`) and
 * the rank display take their level list from, so lane and rank cannot
 * disagree over which sources count.
 */
export function computeSourceBuckets(sources: Iterable<{ level: number; quarantined?: boolean }>): LevelBuckets {
  const levels: number[] = []
  for (const source of sources) if (source.quarantined !== true) levels.push(source.level)
  return computeLevelBuckets(levels)
}

/** Map a source/layer name (falling back to its rank bucket) to a console LayerId. */
export function layerOf(name: string, level: number, buckets: LevelBuckets): LayerId {
  if (isLayerId(name)) return name
  return buckets.get(level) ?? 'company'
}

/**
 * Plain code-point comparison — `a < b`, NOT `localeCompare`. The engine
 * breaks level ties by name the same way (control/sources.mjs `cascadeOrder`)
 * when it inserts at a position, so the list the console shows and the list
 * the engine derives are the same list on every machine and in every locale.
 */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export interface CascadeOrderInput {
  name: string
  level: number
  /**
   * The lane the store already assigned (adaptSources runs `layerOf` over the
   * same source list). Kept as-is when present, so a row can never render in
   * one lane on the Canvas and another in the Overview; computed here from
   * the same buckets only for inputs that carry none (the wizard's drafts).
   */
  layer?: LayerId
}

export type CascadeOrderEntry<T extends CascadeOrderInput = CascadeOrderInput> = Omit<T, 'layer'> & {
  /** 1-based, dense: sources sharing a level share a rank, and the next distinct level is rank + 1. */
  rank: number
  /** Another source sits at the same level — the resolver breaks that tie by freshness, not order. */
  tied: boolean
  /** The lane this source renders in (see `computeLevelBuckets`). */
  layer: LayerId
}

/**
 * Every source with its cascade position, sorted the way the cascade reads:
 * rank ascending, ties by name (code-point). Rank and lane come from one
 * `distinctLevelsDesc` pass, so they cannot drift apart.
 */
export function computeCascadeOrder<T extends CascadeOrderInput>(sources: readonly T[]): CascadeOrderEntry<T>[] {
  const distinct = distinctLevelsDesc(sources.map((s) => s.level))
  const rankByLevel = new Map(distinct.map((level, index) => [level, index + 1]))
  const buckets = computeLevelBuckets(distinct)
  const countByLevel = new Map<number, number>()
  for (const s of sources) countByLevel.set(s.level, (countByLevel.get(s.level) ?? 0) + 1)
  return sources
    .map((s) => ({
      ...s,
      rank: rankByLevel.get(s.level)!,
      tied: (countByLevel.get(s.level) ?? 0) > 1,
      layer: s.layer ?? layerOf(s.name, s.level, buckets),
    }))
    .sort((a, b) => a.rank - b.rank || compareNames(a.name, b.name))
}

/**
 * The names in cascade order — exactly the list `PUT /api/sources/order`
 * takes (index 0 wins). Ties are broken by name so a reorder request built
 * from this list matches the engine's own idea of where a tied source sits.
 */
export function cascadeOrderNames(sources: readonly CascadeOrderInput[]): string[] {
  return computeCascadeOrder(sources).map((s) => s.name)
}

/** `order` with `name` moved to `toIndex` (0-based, clamped). Unknown names leave the list untouched. */
export function moveTo(order: readonly string[], name: string, toIndex: number): string[] {
  const from = order.indexOf(name)
  if (from === -1) return [...order]
  const next = [...order]
  next.splice(from, 1)
  const clamped = Math.max(0, Math.min(Math.trunc(toIndex), next.length))
  next.splice(clamped, 0, name)
  return next
}

/** `#1`, or `#1 (tied)` when another source shares the level. */
export function rankLabel(entry: { rank: number; tied: boolean }): string {
  return `#${entry.rank}${entry.tied ? ' (tied)' : ''}`
}

/**
 * The one-line consequence of a position, for the Overview rows: who this
 * source beats, or that it is the base everything inherits from, or that a
 * tie means the resolver falls back to freshness. `all` is the full cascade
 * (in cascade order) so the names below can be listed.
 */
export function winsOverHint(entry: CascadeOrderEntry, all: readonly CascadeOrderEntry[]): string {
  if (all.length <= 1) return 'The only source — nothing to override, nothing to inherit'
  if (entry.tied) {
    const others = all.filter((s) => s.rank === entry.rank && s.name !== entry.name).map((s) => s.name)
    return `Tied with ${listNames(others)} — most recently updated wins`
  }
  const below = all.filter((s) => s.rank > entry.rank).map((s) => s.name)
  if (below.length === 0) return 'Base — everything above inherits from it'
  return `Wins over ${listNames(below)}`
}

/** "a, b, c" — capped so a twenty-source cascade does not turn a row into a paragraph. */
function listNames(names: readonly string[], max = 3): string {
  const unique = [...new Set(names)]
  if (unique.length <= max) return unique.join(', ')
  return `${unique.slice(0, max).join(', ')} and ${unique.length - max} more`
}

/**
 * The `<select>` options for choosing a position among `namesAbove` — the
 * other sources, in cascade order, WITHOUT the one being placed. One more
 * option than there are others: position k sits below `namesAbove[k - 2]`,
 * position 1 is the top and position N + 1 the bottom.
 */
export function positionOptions(namesAbove: readonly string[]): { value: number; label: string }[] {
  const count = namesAbove.length + 1
  if (count === 1) return [{ value: 1, label: '1 — the only source' }]
  return Array.from({ length: count }, (_, index) => {
    const value = index + 1
    if (value === 1) return { value, label: '1 — top (wins over everything)' }
    const above = namesAbove[value - 2]
    if (value === count) return { value, label: `${value} — bottom (below ${above})` }
    return { value, label: `${value} — below ${above}` }
  })
}
