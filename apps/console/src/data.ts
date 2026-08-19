import type {
  ConflictResolutionRecord, DiscrepancyKind, DiscrepancyLatestDecision, DiscrepancyStatus, DiscrepancyRule, LinkCandidate,
} from './types'
import type { LayerId, RouteId } from './theme'

export interface Layer {
  id: LayerId; name: string; level: number; sub: string; members: string
}

/** Background-index progress for one source, as the views render it. */
export interface SourceProgress {
  /** 'queued' | 'scanning' | 'loading' | 'cloning' | 'ready' | 'error' */
  phase: string
  loaded: number
  /** Null until the engine knows how much there is to read. */
  total: number | null
  /** Serving a good snapshot AND re-reading behind it — subtle, never blocking. */
  refreshing: boolean
}

export interface Source {
  name: string; kind: 'mcp' | 'okf-local'; layer: LayerId
  /** 'indexing': still being read, so any count shown is a floor, not a total.
   *  'degraded': answering, but its last request failed — stale or partial.
   *  'empty': listed cleanly yet serves zero concepts — never painted green. */
  coverage: number; focus: string; status: 'serving' | 'synced' | 'indexing' | 'degraded' | 'error' | 'empty'
  /** Raw engine kind ('okf-local' | 'files' | 'github' | 'mcp') for management UI. */
  sourceKind: string
  /** Credential state reported by the engine; aliases are names, never secrets. */
  authAlias?: string | null
  authState?: 'ok' | 'anonymous' | 'missing-token' | 'host-mismatch'
  level: number
  conceptCount: number
  /** Git remote a clone-backed layer came from; enables Sync alongside kind 'github'. */
  origin?: string | null
  error?: string | null
  /**
   * Not a source at all: a manifest entry the engine could not validate, so
   * nothing was built for it. Rename and Sync have nothing to act on; removing
   * the entry is the repair.
   */
  quarantined?: boolean
  /** Progress while the background index is reading this source. */
  indexing?: SourceProgress
  /** Content this source indexed around: too big to read, or not readable. */
  warnings?: number
  warningMessages?: string[]
  lastSuccessAt?: string | null
  lastErrorAt?: string | null
  /** The manifest's team-capture layer (`live: true`) — removal disables capture. */
  live?: boolean
}

export interface Signal {
  id: string; route: RouteId; repo: string; source: string; owner: string; confidence: number
  title: string; landLayer: LayerId | null; landPath: string | null
  preview: string; conflict?: string
  reasons: [string, string][]
}

export interface Contribution {
  layer: LayerId; sourceLayer: string; value: string; updated: string; note?: string
  /** This dissent is strictly newer than the effective value (day granularity, C-b). */
  fresherDissent?: boolean
  /** `value` is a ≤240-char preview from a compact row; the full text arrives with the detail. */
  truncated?: boolean
}
export interface Conflict {
  id: string; concept: string; sectionKey: string; section: string; title: string
  status: 'open' | 'resolved'; contributions: Contribution[]; winner: LayerId
  safe: boolean
  history: ConflictResolutionRecord[]
  kind?: DiscrepancyKind
  discrepancyStatus?: DiscrepancyStatus
  revision?: string
  owner?: string
  priority?: string
  winnerReason?: string
  effectiveSource?: string | null
  coverageComplete?: boolean
  sourceHealth?: ({ source: string; status: string; error: string | null } | null)[]
  matchingRules?: Pick<DiscrepancyRule, 'id' | 'scope' | 'mode' | 'action' | 'evidenceDecisionIds'>[]
  ruleConflict?: boolean
  target?: string
  affectedLinks?: string[]
  /**
   * True when any raw contribution behind this discrepancy is an array-typed
   * frontmatter value (a list field). The engine 400s a compose against such
   * a field (service.mjs), so the UI disables the compose disposition rather
   * than letting the request round-trip into an error.
   */
  isList?: boolean
  /** The concept's own title and OKF type — the record carries both; the view groups by them. */
  conceptTitle?: string
  conceptType?: string
  /**
   * `false` marks a row built from a compact record: identity, status,
   * revision, candidates and ≤240-char previews are real, but `history` is
   * empty and contribution values may be `truncated`. The full record arrives
   * on selection (store.loadDiscrepancyDetail), which replaces the row and
   * drops this flag. Absent/true means the row carries its full record.
   */
  detailLoaded?: boolean
  /** Broken links only: structural near-matches for `target`, best first. */
  candidates?: LinkCandidate[]
  bestCandidate?: LinkCandidate | null
  /** Compact-row stand-ins for `history` until the detail loads. */
  historyCount?: number
  latestDecision?: DiscrepancyLatestDecision | null
}

/** `sourceLayer` is the source's real name; `layer` is the lane it renders in. */
export interface Dissent { layer: LayerId; sourceLayer: string; value: string; updated?: string | null }
export interface ConceptSection {
  name: string; winner: LayerId; value: string
  /**
   * The name of the source that won this section — the manifest's own layer
   * name, not the three-lane `winner`. Two sources can share a lane, and only
   * this string identifies the one holding the file behind the value.
   */
  sourceLayer: string
  key?: string; updated?: string | null; suppressed?: boolean
  /** All dissenting layers (surfaced, not hidden). */
  dissents?: Dissent[]
  /** At least one dissent is strictly newer than the effective value (C-b). */
  fresherDissent?: boolean
}
export interface Concept {
  id: string; title: string; type: string; layers: LayerId[]
  conflict?: boolean; draft?: boolean; sections: ConceptSection[]
  /**
   * `false` marks a compact row built from the graph summary: identity,
   * lanes and conflict signal are real, but `sections` holds at most the
   * conflict stubs synthesized from the discrepancies payload — not the
   * resolved document. The full resolve arrives on selection
   * (store.loadConceptDetail), which replaces the row and drops this flag.
   * Absent/true means the row carries its full sections (demo bundle, legacy
   * resolve-all fallback, or a loaded detail).
   */
  detailLoaded?: boolean
  /**
   * The real source names behind this concept, winner first — kept
   * separately from `layers` (the three-lane buckets) because a concept with
   * zero sections has no `ConceptSection.sourceLayer` to read a contributor's
   * real name from, and the "Open file" affordance needs one anyway.
   */
  contributorLayers?: string[]
}

export interface Activity {
  pre: string; strong: string; post: string; layer: LayerId; time: string; warn?: boolean
}

// Static lane semantics only (names, precedence, who sees what). Anything
// countable (per-layer concept counts) is derived from the loaded cascade in
// the views — never hand-authored, in demo or live mode.
export const layers: Layer[] = [
  { id: 'company', name: 'Company', level: 0, sub: 'org-wide canonical knowledge', members: 'everyone' },
  { id: 'team', name: 'Team', level: 2, sub: 'runbooks, decisions, system docs', members: 'team members' },
  { id: 'personal', name: 'Personal', level: 3, sub: 'your drafts, notes, overrides', members: 'you' },
]

// Sources, concepts, and conflicts are no longer hand-authored here — they come
// from the DataSource (demo bundle generated by the real resolver, or the live
// playground API) and are adapted to this view model in api.ts. What remains
// below is demo-only content with no resolver equivalent: the triage signal
// queue and the activity feed (shown in demo mode; empty in live).

export const initialSignals: Signal[] = [
  {
    id: 'sig-1', route: 'review_required', repo: 'billing-api', source: 'merged PR', owner: 'Platform', confidence: 0.92,
    title: 'Payment webhook retry runbook after incident', landLayer: 'team', landPath: 'runbooks/payment-webhook-retries',
    preview: 'Drafts a runbook under the Team layer. Inherits escalation contacts from Company.',
    reasons: [['review:label:incident', 'PR carries the incident label'], ['review:keyword:payment', 'Touches payment flows — high blast radius'], ['team:label:runbook', 'Author tagged it as a runbook']],
  },
  {
    id: 'sig-3', route: 'review_required', repo: 'identity-service', source: 'changed files', owner: 'Identity', confidence: 0.88,
    title: 'JWT audience contract changed for internal clients', landLayer: 'team', landPath: 'interfaces/jwt-audience-contract', conflict: 'c2',
    preview: 'Would update the Team interface note — but a Company value already exists for this section.',
    reasons: [['review:keyword:auth', 'Auth-critical surface'], ['review:keyword:contract', 'Declares an interface contract'], ['review:path:auth/', 'Lives under auth/ — owned interface']],
  },
  {
    id: 'sig-6', route: 'review_required', repo: 'billing-api', source: 'repeated question', owner: 'Platform', confidence: 0.79,
    title: 'On-call escalation differs from your personal notes', landLayer: 'personal', landPath: 'runbooks/oncall-escalation', conflict: 'c3',
    preview: 'Your Personal layer overrides the Company escalation path. Confirm to keep, or promote to Team.',
    reasons: [['review:keyword:escalation', 'Escalation / on-call topic'], ['personal:override', 'Contradicts your personal override'], ['team:signal:repeated_question', 'Asked 4× this month']],
  },
  {
    id: 'sig-2', route: 'team_candidate', repo: 'web-app', source: 'repeated question', owner: 'Frontend', confidence: 0.81,
    title: 'Where feature flags are evaluated', landLayer: 'team', landPath: 'systems/web-app/feature-flags',
    preview: 'Auto-drafts a system note under the Team layer. No conflicts.',
    reasons: [['team:signal:repeated_question:5', 'Asked 5× — worth capturing'], ['team:keyword:onboarding', 'Common onboarding question']],
  },
  {
    id: 'sig-4', route: 'team_candidate', repo: 'data-pipeline', source: 'merged PR', owner: 'Data', confidence: 0.74,
    title: 'Deprecate legacy export job after migration', landLayer: 'team', landPath: 'decisions/deprecate-legacy-export-job',
    preview: 'Auto-drafts a decision entry under the Team layer.',
    reasons: [['team:keyword:deprecation', 'Records a deprecation decision'], ['team:keyword:migration', 'Follows a completed migration']],
  },
  {
    id: 'sig-5', route: 'ignore', repo: 'mobile-api', source: 'merged PR', owner: 'API', confidence: 0.86,
    title: 'Bump test fixture snapshots', landLayer: null, landPath: null,
    preview: 'No shared-context write. Stays in repo history only.',
    reasons: [['ignore:keyword:snapshot', 'Snapshot / fixture churn'], ['ignore:label:test-only', 'Test-only change']],
  },
]

export const activity: Activity[] = [
  { pre: 'Stored ', strong: 'Feature flag evaluation', post: ' to Team', layer: 'team', time: '12m' },
  { pre: 'Conflict opened on ', strong: 'primary-db · Engine', post: '', layer: 'team', time: '1h', warn: true },
  { pre: '', strong: 'mobile-api', post: ' swept — no signals', layer: 'team', time: '2h' },
  { pre: 'Personal override on ', strong: 'on-call escalation', post: '', layer: 'personal', time: '5h' },
  { pre: '', strong: 'company-graph', post: ' synced · 126 concepts', layer: 'company', time: '1d' },
]

export const layerName = (id: LayerId) => layers.find((l) => l.id === id)!.name
export const layerLevel = (id: LayerId) => layers.find((l) => l.id === id)!.level
