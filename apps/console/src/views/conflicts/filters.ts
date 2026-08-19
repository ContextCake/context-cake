// The Discrepancy Center's filter model, pure: which tab a status lands in,
// what a tile click sets, and whether a row passes. Kept out of the view so
// the tab counts (from the engine's summary) and the row predicate (over the
// loaded list) cannot disagree about what a tab means.
import type { Conflict } from '../../data'
import type { DiscrepancyKind, DiscrepancyStatus, DiscrepancySummary } from '../../types'
import { displayStatus } from '../../discrepancy-summary'

export type StatusTab = 'actionable' | 'recommended' | 'automated' | 'acknowledged' | 'resolved'

export const STATUS_TABS: { value: StatusTab; label: string; statuses: DiscrepancyStatus[] }[] = [
  { value: 'actionable', label: 'Needs review', statuses: ['needs_review', 'reopened'] },
  { value: 'recommended', label: 'Recommendations', statuses: ['recommended'] },
  { value: 'automated', label: 'Automated', statuses: ['auto_ready', 'blocked'] },
  { value: 'acknowledged', label: 'Acknowledged', statuses: ['acknowledged'] },
  { value: 'resolved', label: 'Resolved', statuses: ['resolved'] },
]

export function tabFor(status: DiscrepancyStatus): StatusTab {
  return STATUS_TABS.find((tab) => tab.statuses.includes(status))?.value ?? 'actionable'
}

export function tabCount(summary: DiscrepancySummary, tab: StatusTab): number {
  const entry = STATUS_TABS.find((item) => item.value === tab)
  return entry ? entry.statuses.reduce((sum, status) => sum + (summary.byStatus[status] ?? 0), 0) : 0
}

export interface ConflictFilters {
  status: StatusTab
  kind: 'all' | DiscrepancyKind
  owner: string
  source: string
  priority: string
  newerOnly: boolean
  /** Broken links the engine has a confident fix for (the "quick win" tile). */
  fixable: boolean
}

export const DEFAULT_FILTERS: ConflictFilters = {
  status: 'actionable', kind: 'all', owner: 'all', source: 'all', priority: 'all', newerOnly: false, fixable: false,
}

export function matchesFilters(item: Conflict, filters: ConflictFilters): boolean {
  const status = displayStatus(item)
  const tab = STATUS_TABS.find((entry) => entry.value === filters.status)
  if (tab && !tab.statuses.includes(status)) return false
  if (filters.kind !== 'all' && (item.kind ?? 'section_content') !== filters.kind) return false
  if (filters.owner !== 'all' && (item.owner ?? 'Unassigned') !== filters.owner) return false
  if (filters.source !== 'all' && item.effectiveSource !== filters.source && !item.contributions.some((entry) => entry.sourceLayer === filters.source)) return false
  if (filters.priority !== 'all' && (item.priority ?? 'unassigned') !== filters.priority) return false
  if (filters.newerOnly && !item.contributions.some((entry) => entry.fresherDissent)) return false
  if (filters.fixable && !item.bestCandidate) return false
  return true
}
