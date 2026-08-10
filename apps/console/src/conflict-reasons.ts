// The acknowledgement-reason catalog for "keep the scoped difference" —
// shared between the full resolver (Conflicts.tsx) and the Cascade inline
// quick-resolve popover so the two surfaces never drift on what a reason
// means or which kinds accept `target_missing`.
import type { AcknowledgementReason, DiscrepancyKind } from './types'

export const REASONS: { value: AcknowledgementReason; label: string }[] = [
  { value: 'different_scopes', label: 'Different scopes' },
  { value: 'temporary_migration', label: 'Temporary migration' },
  { value: 'source_specific_authority', label: 'Source-specific authority' },
  { value: 'other', label: 'Other' },
]
// Broken-link-only: acknowledging why a link target doesn't exist yet is a
// distinct reason from the general four above. The engine's allowedReasons
// set (service.mjs) already accepts this value.
export const TARGET_MISSING_REASON: { value: AcknowledgementReason; label: string } = { value: 'target_missing', label: 'Target not created yet' }

export function reasonOptionsFor(kind: DiscrepancyKind | undefined): { value: AcknowledgementReason; label: string }[] {
  return kind === 'broken_link' ? [...REASONS.slice(0, -1), TARGET_MISSING_REASON, REASONS[REASONS.length - 1]] : REASONS
}
