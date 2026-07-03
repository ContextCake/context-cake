import type { LayerId, RouteId } from './theme'

export interface Layer {
  id: LayerId; name: string; level: number; sub: string; members: string; concepts: number
}

export interface Source {
  name: string; kind: 'repo' | 'mcp' | 'okf-local'; layer: LayerId
  coverage: number; focus: string; status: 'watching' | 'serving' | 'synced'
}

export interface Signal {
  id: string; route: RouteId; repo: string; source: string; owner: string; confidence: number
  title: string; landLayer: LayerId | null; landPath: string | null
  preview: string; conflict?: string
  reasons: [string, string][]
}

export interface Contribution { layer: LayerId; value: string; updated: string; note?: string }
export interface Conflict {
  id: string; concept: string; section: string; title: string
  status: 'open' | 'resolved'; contributions: Contribution[]; winner: LayerId
  resolutionText?: string
}

export interface Dissent { layer: LayerId; value: string }
export interface ConceptSection { name: string; winner: LayerId; value: string; dissent?: Dissent }
export interface Concept {
  id: string; title: string; type: string; layers: LayerId[]
  conflict?: boolean; draft?: boolean; sections: ConceptSection[]
}

export interface Activity {
  pre: string; strong: string; post: string; layer: LayerId; time: string; warn?: boolean
}

export const layers: Layer[] = [
  { id: 'company', name: 'Company', level: 0, sub: 'org-wide canonical knowledge', members: 'everyone', concepts: 126 },
  { id: 'team', name: 'Team', level: 2, sub: 'runbooks, decisions, system docs', members: 'team members', concepts: 38 },
  { id: 'personal', name: 'Personal', level: 3, sub: 'your drafts, notes, overrides', members: 'you', concepts: 14 },
]

export const sources: Source[] = [
  { name: 'billing-api', kind: 'repo', layer: 'team', coverage: 68, focus: 'incident runbooks', status: 'watching' },
  { name: 'identity-service', kind: 'repo', layer: 'team', coverage: 61, focus: 'interface docs', status: 'watching' },
  { name: 'web-app', kind: 'repo', layer: 'team', coverage: 74, focus: 'onboarding answers', status: 'watching' },
  { name: 'data-pipeline', kind: 'repo', layer: 'team', coverage: 57, focus: 'migration decisions', status: 'watching' },
  { name: 'mobile-api', kind: 'repo', layer: 'team', coverage: 82, focus: 'healthy', status: 'watching' },
  { name: 'company-graph', kind: 'mcp', layer: 'company', coverage: 100, focus: 'canonical org knowledge · MCP', status: 'serving' },
  { name: 'kb-personal', kind: 'okf-local', layer: 'personal', coverage: 100, focus: 'local notes bundle', status: 'synced' },
]

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

export const initialConflicts: Conflict[] = [
  {
    id: 'c1', concept: 'systems/primary-db', section: 'Engine {#engine}', title: 'Which engine backs the primary database', status: 'open',
    contributions: [
      { layer: 'company', value: 'Postgres.', updated: '2025-11-02', note: 'org default' },
      { layer: 'team', value: 'SingleStore — chosen for HTAP workloads.', updated: '2026-04-18', note: 'Data team decision' },
    ], winner: 'team',
  },
  {
    id: 'c2', concept: 'interfaces/jwt-audience-contract', section: 'Audience {#audience}', title: 'JWT audience for internal service-to-service calls', status: 'open',
    contributions: [
      { layer: 'company', value: 'aud = "api.acme.com" for all clients.', updated: '2025-09-10' },
      { layer: 'team', value: 'aud = "internal.acme.com" for service-to-service.', updated: '2026-06-28', note: 'Identity team' },
    ], winner: 'team',
  },
  {
    id: 'c3', concept: 'runbooks/oncall-escalation', section: 'Escalation {#escalation}', title: 'First hop when billing pages at 3am', status: 'open',
    contributions: [
      { layer: 'company', value: 'Page the platform on-call, then the EM.', updated: '2025-08-01' },
      { layer: 'personal', value: 'Ping @dana directly first — she owns billing.', updated: '2026-06-30', note: 'your override' },
    ], winner: 'personal',
  },
]

export const concepts: Concept[] = [
  {
    id: 'systems/primary-db', title: 'Primary database', type: 'system', layers: ['company', 'team'], conflict: true,
    sections: [
      { name: 'Engine', winner: 'team', value: 'SingleStore — chosen for HTAP workloads.', dissent: { layer: 'company', value: 'Postgres.' } },
      { name: 'Backups', winner: 'company', value: 'Nightly snapshots to cold storage, 30-day retention.' },
      { name: 'Connection pool', winner: 'team', value: 'PgBouncer in transaction mode, 200 max connections.' },
    ],
  },
  {
    id: 'interfaces/jwt-audience-contract', title: 'JWT audience contract', type: 'interface', layers: ['company', 'team'], conflict: true,
    sections: [
      { name: 'Audience', winner: 'team', value: 'aud = "internal.acme.com" for service-to-service calls.', dissent: { layer: 'company', value: 'aud = "api.acme.com" for all clients.' } },
      { name: 'Rotation', winner: 'company', value: 'Signing keys rotate every 90 days via the JWKS endpoint.' },
    ],
  },
  {
    id: 'runbooks/oncall-escalation', title: 'On-call escalation', type: 'runbook', layers: ['company', 'personal'], conflict: true,
    sections: [
      { name: 'Escalation', winner: 'personal', value: 'Ping @dana directly first — she owns billing.', dissent: { layer: 'company', value: 'Page the platform on-call, then the EM.' } },
      { name: 'Severity', winner: 'company', value: 'SEV-1 if customer payments fail; SEV-2 for internal only.' },
    ],
  },
  {
    id: 'runbooks/payment-webhook-retries', title: 'Payment webhook retries', type: 'runbook', layers: ['team'], draft: true,
    sections: [
      { name: 'Symptom', winner: 'team', value: 'Webhooks return 5xx during provider incidents.' },
      { name: 'Fix', winner: 'team', value: 'Replay from the dead-letter queue after the provider recovers.' },
    ],
  },
  {
    id: 'systems/web-app/feature-flags', title: 'Feature flag evaluation', type: 'system', layers: ['team'],
    sections: [
      { name: 'Where', winner: 'team', value: 'Flags resolve server-side in the edge middleware, not the client.' },
      { name: 'Fallback', winner: 'team', value: 'Unknown flags default to off and log a warning.' },
    ],
  },
  {
    id: 'decisions/deprecate-legacy-export-job', title: 'Deprecate legacy export job', type: 'decision', layers: ['team'], draft: true,
    sections: [
      { name: 'Decision', winner: 'team', value: 'Remove the nightly CSV export after the warehouse migration lands.' },
      { name: 'Owner', winner: 'team', value: 'Data team, targeting end of Q3.' },
    ],
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
