// Orientation that is only worth reading once. A three-step "here is how this
// works" strip earns its space on the first visit and becomes furniture on
// every visit after, so hints live in a popover that dismisses itself for good
// rather than in the layout.
//
// Renderer-local on purpose: this is not a synced preference, and a hint the
// user has already dismissed reappearing on a second machine is a smaller
// failure than a desktop IPC round trip on every view mount.
const KEY_PREFIX = 'contextcake.hintSeen.'

export type HintId = 'discrepancy-workflow'

export function hintSeen(id: HintId): boolean {
  // Storage unavailable (private mode, embedded frame) reads as "seen": a hint
  // that cannot record its dismissal would otherwise return on every mount.
  try { return localStorage.getItem(KEY_PREFIX + id) === '1' } catch { return true }
}

export function markHintSeen(id: HintId): void {
  try { localStorage.setItem(KEY_PREFIX + id, '1') } catch { /* optional preference */ }
}
