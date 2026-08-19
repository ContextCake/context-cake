// Pure helpers over the Discrepancy Center's view model — no React, no store.
//
// Two of them exist to answer one question in one place. `isActionable` is
// the predicate the Overview tile, the sidebar badge, the header count and the
// Conflicts view all agree on (it used to be copied into each of the four).
// `summarizeConflicts` mirrors the engine's `summarizeDiscrepancies`
// (packages/core/src/discrepancies.mjs) so the same header can be drawn from
// the demo bundle or from an engine too old to serve `?fields=compact`;
// against a modern engine the summary arrives on the wire and this is not
// consulted.
import type { Conflict } from './data'
import type { DiscrepancyKind, DiscrepancyStatus, DiscrepancySummary, LinkCandidate } from './types'

export const ACTIONABLE_STATUSES: ReadonlySet<DiscrepancyStatus> = new Set<DiscrepancyStatus>([
  'needs_review', 'reopened', 'recommended', 'auto_ready', 'blocked',
])

/**
 * Per-item batch codes that mean NOT ATTEMPTED (stopOnError / a recovery
 * stop, or the engine's ~10 s lock budget ran out) — those are resubmitted,
 * they did not fail.
 */
export const NOT_ATTEMPTED_CODES: ReadonlySet<string> = new Set(['SKIPPED', 'BATCH_TIME_BUDGET'])

/** Split a batch's results into what landed, what failed, and what the engine never reached. */
export function partitionBatchResults<T extends { ok: boolean; code?: string; discrepancyId: string | null }>(results: T[]): { ok: T[]; failed: T[]; notAttempted: T[] } {
  const out = { ok: [] as T[], failed: [] as T[], notAttempted: [] as T[] }
  for (const result of results) {
    if (result.ok) out.ok.push(result)
    else if (result.code && NOT_ATTEMPTED_CODES.has(result.code)) out.notAttempted.push(result)
    else out.failed.push(result)
  }
  return out
}

export const DISCREPANCY_KINDS: readonly DiscrepancyKind[] = ['section_content', 'frontmatter_value', 'broken_link', 'changed_after_decision']
export const DISCREPANCY_STATUSES: readonly DiscrepancyStatus[] = ['needs_review', 'recommended', 'auto_ready', 'acknowledged', 'resolved', 'reopened', 'blocked']

export const KIND_LABEL: Record<DiscrepancyKind, string> = {
  section_content: 'Section content', frontmatter_value: 'Frontmatter value',
  broken_link: 'Broken link', changed_after_decision: 'Changed after decision',
}

/**
 * The status a row displays. A legacy conflict (no engine record behind it)
 * is `needs_review` while open and `resolved` once the log says so.
 */
export function displayStatus(conflict: Pick<Conflict, 'discrepancyStatus' | 'status'>): DiscrepancyStatus {
  return conflict.discrepancyStatus ?? (conflict.status === 'resolved' ? 'resolved' : 'needs_review')
}

export function displayKind(conflict: Pick<Conflict, 'kind'>): DiscrepancyKind {
  return conflict.kind ?? 'section_content'
}

/**
 * A broken link stays one after it reopens as `changed_after_decision` —
 * the engine gates the fix actions on `originalKind`, so every broken-link
 * branch here asks this, never `kind === 'broken_link'`.
 */
export function isBrokenLink(conflict: Pick<Conflict, 'kind' | 'originalKind'>): boolean {
  return (conflict.originalKind ?? conflict.kind) === 'broken_link'
}

/**
 * The kind a row is filed under on screen: a broken link stays "broken link"
 * after it reopens (its `kind` is then `changed_after_decision`). The tiles,
 * the kind filter and the Overview subtitle all count with this, so a tile's
 * number and its filter never disagree.
 */
export function effectiveKind(conflict: Pick<Conflict, 'kind' | 'originalKind'>): DiscrepancyKind {
  return isBrokenLink(conflict) ? 'broken_link' : displayKind(conflict)
}

/** Something a person (or an automatic rule) still has to do about it. */
export function isActionable(conflict: Pick<Conflict, 'discrepancyStatus' | 'status'>): boolean {
  return ACTIONABLE_STATUSES.has(displayStatus(conflict))
}

/** The empty summary — one shared identity, so an unloaded store never hands out a fresh object per render. */
export const NO_SUMMARY: DiscrepancySummary = {
  total: 0, actionable: 0,
  byKind: { section_content: 0, frontmatter_value: 0, broken_link: 0, changed_after_decision: 0 },
  byStatus: { needs_review: 0, recommended: 0, auto_ready: 0, acknowledged: 0, resolved: 0, reopened: 0, blocked: 0 },
  bySourcePair: [], byOwner: [], byConceptType: [], topTargets: [], topConcepts: [],
  quickWins: { autoReady: 0, recommended: 0, brokenLinksWithBestCandidate: 0, brokenLinksTotal: 0 },
}

const sourceNames = (conflict: Conflict) => conflict.contributions.map((entry) => entry.sourceLayer)

/**
 * Mirror of the engine's summarizeDiscrepancies over the console view model.
 * Same rows, same ordering (count desc, actionable desc, key asc), same
 * `topN` cap, so a header drawn from this and one drawn from the wire agree.
 */
export function summarizeConflicts(conflicts: Conflict[], { topN = 25 } = {}): DiscrepancySummary {
  const byKind: Record<DiscrepancyKind, number> = { section_content: 0, frontmatter_value: 0, broken_link: 0, changed_after_decision: 0 }
  const byStatus: Record<DiscrepancyStatus, number> = { needs_review: 0, recommended: 0, auto_ready: 0, acknowledged: 0, resolved: 0, reopened: 0, blocked: 0 }
  type Row<T> = T & { count: number; actionable: number }
  const sourcePairs = new Map<string, Row<{ sources: string[] }>>()
  const owners = new Map<string, Row<{ owner: string }>>()
  const conceptTypes = new Map<string, Row<{ conceptType: string }>>()
  const targets = new Map<string, Row<{ target: string; bestCandidate: LinkCandidate | null; agree: boolean }>>()
  const concepts = new Map<string, Row<{ conceptId: string; conceptTitle: string }>>()
  const quickWins = { autoReady: 0, recommended: 0, brokenLinksWithBestCandidate: 0, brokenLinksTotal: 0 }
  let actionable = 0

  const bump = <T,>(map: Map<string, Row<T>>, key: string, active: boolean, extra: T): Row<T> => {
    const row = map.get(key) ?? { ...extra, count: 0, actionable: 0 }
    row.count += 1
    if (active) row.actionable += 1
    map.set(key, row)
    return row
  }

  for (const item of conflicts) {
    const status = displayStatus(item)
    const kind = displayKind(item)
    const active = ACTIONABLE_STATUSES.has(status)
    if (active) actionable += 1
    byKind[kind] += 1
    byStatus[status] += 1
    const sources = [...sourceNames(item)].sort()
    bump(sourcePairs, sources.join('|'), active, { sources })
    const owner = item.owner ?? 'Unassigned'
    bump(owners, owner, active, { owner })
    const conceptType = item.conceptType ?? 'concept'
    bump(conceptTypes, conceptType, active, { conceptType })
    bump(concepts, item.concept, active, { conceptId: item.concept, conceptTitle: item.conceptTitle ?? item.concept })
    if (isBrokenLink(item) && typeof item.target === 'string') {
      const row = bump(targets, item.target, active, { target: item.target, bestCandidate: null, agree: true })
      // The shared candidate is agreed over the ACTIONABLE rows only (as the
      // engine does): a resolved row — the audit trail of a link already
      // fixed — carries none, and must not veto the group's default.
      if (active) {
        if (row.actionable === 1) row.bestCandidate = item.bestCandidate ?? null
        else if ((row.bestCandidate?.id ?? null) !== (item.bestCandidate?.id ?? null)) row.agree = false
        quickWins.brokenLinksTotal += 1
        if (item.bestCandidate) quickWins.brokenLinksWithBestCandidate += 1
      }
    }
    if (status === 'auto_ready') quickWins.autoReady += 1
    if (status === 'recommended') quickWins.recommended += 1
  }

  const top = <T,>(map: Map<string, Row<T>>): (Row<T> & { key: string })[] => [...map.entries()]
    .sort(([ka, a], [kb, b]) => b.count - a.count || b.actionable - a.actionable || ka.localeCompare(kb))
    .slice(0, topN)
    .map(([key, row]) => ({ key, ...row }))

  return {
    total: conflicts.length,
    actionable,
    byKind,
    byStatus,
    bySourcePair: top(sourcePairs).map(({ key, sources, count, actionable: a }) => ({ key, sources, count, actionable: a })),
    byOwner: top(owners).map(({ owner, count, actionable: a }) => ({ owner, count, actionable: a })),
    byConceptType: top(conceptTypes).map(({ conceptType, count, actionable: a }) => ({ conceptType, count, actionable: a })),
    topTargets: top(targets).map(({ target, count, actionable: a, bestCandidate, agree }) => ({ target, count, actionable: a, bestCandidate: agree ? bestCandidate : null })),
    topConcepts: top(concepts).map(({ conceptId, conceptTitle, count, actionable: a }) => ({ conceptId, conceptTitle, count, actionable: a })),
    quickWins,
  }
}

export type GroupBy = 'kind' | 'target' | 'concept' | 'sourcePair' | 'owner'

export interface ConflictGroup {
  /** Stable across re-renders and refetches — the collapse/selection state is keyed by it. */
  key: string
  label: string
  count: number
  actionable: number
  items: Conflict[]
  /** Every item is a broken link to this one target. */
  sharedTarget?: string
  /** …and every one of them agrees on this fix. */
  sharedBestCandidate?: LinkCandidate | null
  /** Sources present in EVERY item's contributions (the "Use <source> for N" candidates). */
  sharedSources?: string[]
}

/** What a set of rows has in common — the facts every bulk/group action is gated on. */
export interface ItemsDescription {
  allBrokenLinks: boolean
  anyBrokenLink: boolean
  /** Every item is a broken link to this one target. */
  sharedTarget?: string
  /** …and every one of them agrees on this fix (null when they disagree or none has one). */
  sharedBestCandidate?: LinkCandidate | null
  /** Union of the items' candidates by id, best first — the choices a rewrite may offer. */
  candidates: LinkCandidate[]
  /** Sources present in EVERY item's contributions; only for sets with no broken link. */
  sharedSources?: string[]
}

export function describeItems(items: Conflict[]): ItemsDescription {
  const allBrokenLinks = items.length > 0 && items.every(isBrokenLink)
  const anyBrokenLink = items.some(isBrokenLink)
  const out: ItemsDescription = { allBrokenLinks, anyBrokenLink, candidates: [] }
  if (allBrokenLinks) {
    const target = items[0].target
    if (typeof target === 'string' && items.every((item) => item.target === target)) {
      out.sharedTarget = target
      // Agreed over the ACTIONABLE rows only, mirroring summarizeConflicts: a
      // resolved row carries no candidate and must not veto the group's fix.
      const active = items.filter(isActionable)
      const best = active[0]?.bestCandidate?.id ?? null
      out.sharedBestCandidate = best !== null && active.every((item) => (item.bestCandidate?.id ?? null) === best)
        ? active[0].bestCandidate ?? null
        : null
    }
    const byId = new Map<string, LinkCandidate>()
    for (const item of items) {
      for (const candidate of item.candidates ?? []) {
        const known = byId.get(candidate.id)
        if (!known || known.confidence < candidate.confidence) byId.set(candidate.id, candidate)
      }
    }
    out.candidates = [...byId.values()].sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
  }
  // "Use <source> for N" is a section/frontmatter action; one broken link in
  // the set and the engine would 409 it, so a mixed set offers none.
  if (!anyBrokenLink && items.length > 0) {
    let shared = new Set(sourceNames(items[0]))
    for (const item of items.slice(1)) {
      const mine = new Set(sourceNames(item))
      shared = new Set([...shared].filter((name) => mine.has(name)))
      if (shared.size === 0) break
    }
    out.sharedSources = [...shared].sort()
  }
  return out
}

function finishGroup(key: string, label: string, items: Conflict[]): ConflictGroup {
  const { sharedTarget, sharedBestCandidate, sharedSources } = describeItems(items)
  return {
    key, label, count: items.length, actionable: items.filter(isActionable).length, items,
    ...(sharedTarget !== undefined ? { sharedTarget, sharedBestCandidate } : {}),
    ...(sharedSources !== undefined ? { sharedSources } : {}),
  }
}

/** Actionable rows per effective kind — what the tiles and the Overview subtitle count (decided rows are noise there). */
export function actionableByKind(conflicts: Conflict[]): Record<DiscrepancyKind, number> {
  const out: Record<DiscrepancyKind, number> = { section_content: 0, frontmatter_value: 0, broken_link: 0, changed_after_decision: 0 }
  for (const item of conflicts) if (isActionable(item)) out[effectiveKind(item)] += 1
  return out
}

/**
 * The rule suggestion a batch's receipt may offer: one whose action is what
 * the batch just did (and, for broken links, whose target is the batch's).
 * Anything else mined at the same time belongs in the rules panel, not on a
 * receipt that would read as "turn what you just did into a rule".
 */
export function suggestionForBatch<S extends { id: string; match: { kind: DiscrepancyKind; target?: string }; action: { type: string } }>(
  suggestions: S[] | undefined,
  batch: { action: string; selectedSource?: string; newTarget?: string; reasonCode?: string; target?: string },
): S | undefined {
  const wanted = batch.action === 'acknowledge' ? 'acknowledge' : batch.action === 'choose_contribution' ? 'prefer_source' : batch.action === 'rewrite_link' ? 'rewrite_link' : null
  if (!wanted) return undefined
  return (suggestions ?? []).find((suggestion) => {
    const action = suggestion.action as { type: string; source?: string; newTarget?: string; reasonCode?: string }
    if (action.type !== wanted) return false
    if (wanted === 'prefer_source' && action.source !== batch.selectedSource) return false
    if (wanted === 'rewrite_link' && action.newTarget !== batch.newTarget) return false
    if (wanted === 'acknowledge' && batch.reasonCode && action.reasonCode !== batch.reasonCode) return false
    if (batch.target !== undefined && suggestion.match.target !== batch.target) return false
    return true
  })
}

const byCountThenLabel = (a: ConflictGroup, b: ConflictGroup) => b.count - a.count || a.label.localeCompare(b.label)

/**
 * Bucket rows for the grouped list. Groups sort by size (largest first) so
 * "412 broken links to nine targets" reads off the top of the list.
 *
 *   kind        — one group per kind, except broken links, which sub-group by
 *                 target (that is the group a fix action applies to)
 *   target      — broken links by target; everything else under its kind
 *   concept     — by concept id, labelled with the concept's title
 *   sourcePair  — by the set of contributing sources
 *   owner       — by owner (Unassigned last only by alphabet, not by rule)
 */
export function groupConflicts(conflicts: Conflict[], groupBy: GroupBy): ConflictGroup[] {
  const buckets = new Map<string, { label: string; items: Conflict[] }>()
  const put = (key: string, label: string, item: Conflict) => {
    const bucket = buckets.get(key)
    if (bucket) bucket.items.push(item)
    else buckets.set(key, { label, items: [item] })
  }
  for (const item of conflicts) {
    const kind = displayKind(item)
    switch (groupBy) {
      case 'kind':
      case 'target':
        if (isBrokenLink(item)) put(`target:${item.target ?? ''}`, `Broken link → ${item.target ?? '(no target)'}`, item)
        else put(`kind:${kind}`, KIND_LABEL[kind], item)
        break
      case 'concept':
        put(`concept:${item.concept}`, item.conceptTitle ?? item.concept, item)
        break
      case 'sourcePair': {
        const sources = [...sourceNames(item)].sort()
        put(`sources:${sources.join('|')}`, sources.length ? sources.join(' + ') : 'No contributing sources', item)
        break
      }
      case 'owner':
        put(`owner:${item.owner ?? 'Unassigned'}`, item.owner ?? 'Unassigned', item)
        break
    }
  }
  return [...buckets.entries()].map(([key, { label, items }]) => finishGroup(key, label, items)).sort(byCountThenLabel)
}

/**
 * Everything the toolbar search can match a row on, lowercased once. The old
 * predicate re-stringified every contribution of every row per keystroke;
 * this is computed per row when the list changes and then `includes`-tested.
 */
export function buildHaystack(conflict: Conflict): string {
  return [
    conflict.concept, conflict.conceptTitle, conflict.title, conflict.section, conflict.owner, conflict.kind, conflict.target,
    conflict.bestCandidate?.id,
    ...conflict.contributions.flatMap((entry) => [entry.sourceLayer, entry.value]),
  ].map((value) => String(value ?? '')).join('\n').toLowerCase()
}
