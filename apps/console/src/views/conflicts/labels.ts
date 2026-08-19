// Copy shared by the Discrepancy Center's pieces — one place for what a
// status, a kind or a candidate reason is called on screen.
import type { DiscrepancyStatus, LinkCandidate } from '../../types'

export { KIND_LABEL } from '../../discrepancy-summary'

export const STATUS_LABEL: Record<DiscrepancyStatus, string> = {
  needs_review: 'Needs review', reopened: 'Needs review', recommended: 'Recommendations',
  auto_ready: 'Automated', acknowledged: 'Acknowledged', resolved: 'Resolved', blocked: 'Automated',
}

/** Why the engine thinks a candidate is the link's real target — plain words for the reason enum. */
export const CANDIDATE_REASON: Record<string, string> = {
  relative: 'relative path resolves',
  case: 'differs only by case',
  extension: 'differs only by extension',
  slug: 'same slug',
  moved: 'same file name elsewhere',
  title: 'matches a concept title',
  slug_moved: 'same slug elsewhere',
  typo: 'one or two characters off',
}

export function candidateReason(candidate: LinkCandidate): string {
  return CANDIDATE_REASON[candidate.reason] ?? candidate.reason
}

export function formatDate(value?: string | null) {
  if (!value) return 'Date not recorded'
  const parsed = new Date(value.includes('T') ? value : `${value}T12:00:00`)
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: value.includes('T') ? 'short' : undefined }).format(parsed)
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
