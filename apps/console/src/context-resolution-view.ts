import type { Conflict } from './data'
import type { ContextResolutionDecision } from './types'

/** A presentation only view; control operations continue to use raw discrepancies. */
export function withContextResolutionDecisions(conflicts: Conflict[], decisions: ContextResolutionDecision[]): Conflict[] {
  if (!decisions.length) return conflicts
  const latest = new Map(decisions.map((decision) => [JSON.stringify([decision.conceptId, decision.key]), decision]))
  return conflicts.map((conflict) => {
    if ((conflict.originalKind ?? conflict.kind) !== 'section_content') return conflict
    const decision = latest.get(JSON.stringify([conflict.concept, conflict.sectionKey]))
    if (!decision || decision.currentStatus !== 'applied' || decision.undoneAt || decision.currentRevision !== conflict.revision || !conflict.revision) return conflict
    const selected = conflict.contributions.find((item) => item.sourceLayer === decision.selectedSource)
    if (!selected) return conflict
    return { ...conflict, status: 'resolved', discrepancyStatus: 'resolved', winner: selected.layer,
      originalEffectiveSource: conflict.effectiveSource,
      effectiveSource: selected.sourceLayer,
      winnerReason: `${selected.sourceLayer} is selected by an exact source policy. Original source answers are preserved.`,
      contextResolution: { decisionId: decision.id, policyId: decision.policyId, selectedSource: decision.selectedSource, status: 'applied' } }
  })
}
