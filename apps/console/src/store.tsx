import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react'
import {
  activity as demoActivity, initialSignals,
  type Activity, type Concept, type Conflict, type Signal, type Source,
} from './data'
import {
  adaptConcept, adaptConflicts, adaptDiscrepancies, adaptDiscrepancy, adaptGraphConcept, adaptSources, attachConflictStubs,
  computeSourceBuckets, createDataSource, LiveDataError, mergeSourceStatus, runSequentially,
  type CascadeOrderResult, type IndexingActivity, type IndexingControlAction, type Mode,
} from './api'
import { isActionable, NO_SUMMARY, summarizeConflicts } from './discrepancy-summary'
import type {
  DiscrepancyBatchRequest, DiscrepancyBatchResponse, DiscrepancyDecisionRequest, DiscrepancyRule,
  DiscrepancyRuleSuggestion, DiscrepancySummary, GraphSummary, SearchHit, SourceStatus, StatusSummary,
} from './types'
import type { LayerId, RouteId } from './theme'
import { dispatchNavigationGuard, filesHash, isViewId, parseHash, titleForView, type ViewId } from './shell-navigation'

export type { ViewId } from './shell-navigation'
export type TriageTab = 'review' | 'captured' | 'ignored'

const BROWSER_LAST_VIEW_KEY = 'contextcake.lastView'
const BROWSER_KNOWLEDGE_VIEW_KEY = 'contextcake.knowledgeView'
const BROWSER_REVIEW_VIEW_KEY = 'contextcake.reviewView'

function initialRoute(): { view: ViewId; concept?: string; layer?: string; file?: string } {
  if (typeof window === 'undefined') return { view: 'overview' }
  const explicit = parseHash(window.location.hash)
  if (explicit.view) return { view: explicit.view, concept: explicit.concept, layer: explicit.layer, file: explicit.file }
  const desktop = window.__CC_DESKTOP?.uiState?.initial.lastView
  if (isViewId(desktop)) return { view: desktop }
  try {
    const browser = localStorage.getItem(BROWSER_LAST_VIEW_KEY)
    if (isViewId(browser)) return { view: browser }
  } catch { /* browser storage is optional */ }
  return { view: 'overview' }
}

export interface Cite { layer: LayerId; label: string }
export interface ChatMessage {
  role: 'assistant' | 'user'
  text: string
  intro?: boolean
  cites?: Cite[]
  note?: string
  /** Canned (no live agent connected) — the UI labels these honestly. */
  canned?: boolean
}

/** Live mode has no activity feed. Shared so its identity never moves. */
const NO_ACTIVITY: Activity[] = []

const initialMessages: ChatMessage[] = []

declare global {
  interface Window {
    claude?: { complete?: (prompt: string) => Promise<string> }
  }
}

const TAB_TO_ROUTE: Record<TriageTab, RouteId> = {
  review: 'review_required', captured: 'team_candidate', ignored: 'ignore',
}

/**
 * The Queue's one tab, filtered by the toolbar search.
 *
 * Pure, and exported rather than handed out as a store callback, because the
 * callback version is what broke the Queue: it closed over a `queryRef` so its
 * identity never changed, which meant `Triage` could call it while subscribing
 * only to the data and nav contexts — and then sat out every keystroke. Taking
 * `query` as an argument puts the dependency in the type, so a caller has to
 * have subscribed to it before it can call this at all.
 */
export function filterSignals(signals: Signal[], tab: TriageTab, query: string): Signal[] {
  const route = TAB_TO_ROUTE[tab]
  const q = query.trim().toLowerCase()
  return signals.filter(
    (s) => s.route === route && (!q || `${s.title} ${s.repo} ${s.owner}`.toLowerCase().includes(q)),
  )
}

/** How many full concept details the renderer holds at once (LRU). */
const DETAIL_CACHE_LIMIT = 50

/**
 * A compact textual view of the resolved cascade, for the chat prompt.
 * Bounded to the details actually loaded (graph-first rows carry no document
 * text) and capped — at vault scale the whole corpus was never a viable
 * prompt anyway, it just silently was one.
 */
const CHAT_CONTEXT_MAX_CONCEPTS = 30
const CHAT_CONTEXT_MAX_CHARS = 40_000
function buildContext(concepts: Concept[]): string {
  return concepts
    .filter((c) => c.detailLoaded !== false && c.sections.length > 0)
    .slice(0, CHAT_CONTEXT_MAX_CONCEPTS)
    .map((c) => `${c.id}: ` + c.sections
      .map((s) => `${s.name} = "${s.value}" [${s.winner}]`
        + (s.dissents ?? []).map((d) => ` (conflicts with ${d.layer}: "${d.value}")`).join(''))
      .join('; '))
    .join('\n')
    .slice(0, CHAT_CONTEXT_MAX_CHARS)
}

function cannedAnswer(q: string): { text: string; cites: Cite[]; note?: string } {
  const s = q.toLowerCase()
  if (/(jwt|audience|auth|token)/.test(s)) return { text: 'For internal service-to-service calls, the JWT audience is "internal.acme.com".', cites: [{ layer: 'team', label: 'Team · interfaces/auth-tokens' }], note: 'The Company contract still says "api.acme.com" for external clients — surfaced as a conflict.' }
  if (/(on.?call|escalat|page|incident)/.test(s)) return { text: 'Company policy is to page the platform on-call, then the EM. A personal override can point at a specific owner first.', cites: [{ layer: 'company', label: 'Company · runbooks/incident-response' }], note: 'Higher layers override per section; the rest is inherited.' }
  if (/(deploy|release|ship)/.test(s)) return { text: 'Deploys go through the team runbook — staged rollout with health checks between steps.', cites: [{ layer: 'team', label: 'Team · runbooks/deploy' }] }
  if (/(database|db|postgres|store|singlestore)/.test(s)) return { text: 'The team runs SingleStore for the primary database — chosen for HTAP workloads.', cites: [{ layer: 'team', label: 'Team · decisions/primary-db' }], note: 'Overrides the Company default (Postgres) for the Engine section only.' }
  return { text: 'I resolved that across all three layers but found nothing specific. Try asking about the database, auth tokens, deploys, or incident response.', cites: [] }
}

/** One piece of background work the engine is doing right now. */
export interface BackgroundTask {
  name: string
  kind: string
  /** 'queued' | 'scanning' | 'loading' | 'cloning' | 'ready' | 'error' */
  phase: string
  loaded: number
  /** Null until the engine knows how much there is to read. */
  total: number | null
  /**
   * Serving a good snapshot AND re-reading behind it. The distinction matters
   * in the UI: a refreshing source has an answer, so it never gets a spinner
   * held up in front of it — only a quiet note that fresher data is coming.
   */
  refreshing: boolean
  /** Since this console first saw the task running — a clock, not engine state. */
  elapsedMs: number
}

/** What the shell is waiting on. `shell` is the only state that blocks the UI. */
export interface LoadState {
  /** True only until the source topology is known — milliseconds, not minutes. */
  shell: boolean
  /** True while concepts are still being resolved in the background. */
  concepts: boolean
  /** Sources the engine is still reading. */
  indexingSources: string[]
  /** Every source with work in flight, indexing or refreshing. */
  tasks: BackgroundTask[]
  /**
   * A background refresh is failing. Non-fatal by construction: the page keeps
   * whatever it already had, the poll keeps retrying, and this is what the UI
   * shows so a stalled feed can never look like a live one.
   */
  refreshError: LiveDataError | null
  /** When the last poll succeeded, so the header can say how old the page is. */
  lastRefreshAt: number | null
}

/** Cheap-status cadence while the engine reports work in flight. */
const ACTIVE_POLL_MS = 900
/**
 * Idle cadence. /api/status is O(sources) and answers in under a millisecond,
 * so watching for a re-index started outside this window (a file edited on
 * disk, a source synced from another surface) costs nothing.
 */
const IDLE_POLL_MS = 5_000
/** Backoff ceiling. There is deliberately no failure count that stops the loop. */
const MAX_BACKOFF_MS = 5_000
/**
 * Cadence for a HIDDEN tab while the engine reports work in flight (indexing
 * or refreshing). A hidden tab still goes fully silent once nothing is
 * active — that cost optimization stays exactly as before — but a hidden tab
 * that landed on a still-indexing snapshot used to have nothing left to
 * resume it until visibilitychange fired, which could be never (a
 * backgrounded tab the user doesn't return to for minutes). /api/status
 * answers in 2-4ms, so ~8x the active cadence is cheap enough to run
 * unattended and still finishes a bounded indexing pass in single-digit
 * seconds instead of stalling indefinitely.
 */
const HIDDEN_ACTIVE_POLL_MS = 7_000

/**
 * The part of the engine's status that decides what /api/graph and
 * /api/resolve-all would answer. Progress counters are deliberately excluded:
 * the engine's `generation` moves for every document read, and pulling a
 * 150MB resolve-all back for each tick of a counter is exactly what made the
 * app feel laggy while a large vault indexed.
 */
function contentSignature(rows: {
  name: string; level: number; conceptCount: number; status: string
  refreshing?: boolean; error?: string | null
}[]): string {
  return rows
    .map((r) => `${r.name}~${r.level}~${r.conceptCount}~${r.status}~${r.refreshing ? 1 : 0}~${r.error ?? ''}`)
    .join('|')
}

/** Graph rows carry the same fields under a different shape. */
function graphSignature(g: GraphSummary): string {
  return contentSignature(g.sources.map((s) => ({
    name: s.name, level: s.level, conceptCount: s.conceptCount, status: s.status,
    refreshing: s.indexing?.refreshing === true, error: s.error,
  })))
}

function asLiveDataError(e: unknown): LiveDataError {
  if (e instanceof LiveDataError) return e
  return new LiveDataError('bad-shape', e instanceof Error ? e.message : String(e))
}

/**
 * The store is four contexts, not one, and the split is by how often each
 * changes rather than by subject.
 *
 * A single context value memoized over ~25 dependencies meant one keystroke in
 * the toolbar search re-rendered the sidebar, the header and the active view —
 * every consumer, for a value only the view cares about. Splitting by cadence
 * is what lets a component subscribe to what it actually reads:
 *
 *   data  — engine answers and every action. Changes when the cascade changes.
 *   nav   — where the user is. Changes on navigation and selection.
 *   input — the toolbar search box. Changes per keystroke.
 *   chat  — the Ask composer and its transcript. Changes per keystroke.
 *
 * The two typing surfaces are separate contexts because they have disjoint
 * audiences: `query` is read by the Header that owns the field and by all five
 * searchable views, the composer only by the Ask panel. Sharing one context
 * meant a question typed into a panel floating OVER a view repainted the view
 * for every character of it.
 *
 * None of this survives a `data` value that changes identity per provider
 * render — see NO_ACTIVITY above, which is what that mistake looks like.
 *
 * Actions all live in `data` and are all stable identities, so a memoized child
 * that takes one as a prop keeps its memo.
 *
 * `useStore()` still hands back all four merged, for consumers that genuinely
 * read across them; it re-renders on any of the four, which is the cost of
 * that convenience. Prefer the narrow hooks in anything on a hot path.
 */
export interface StoreData {
  mode: Mode
  loading: boolean
  load: LoadState
  error: LiveDataError | null

  concepts: Concept[]
  sources: Source[]
  signals: Signal[]
  conflicts: Conflict[]
  /**
   * Counts and groupings over every discrepancy — the engine's own summary
   * when it serves one (`?fields=compact`), the local mirror otherwise. Read
   * for the Discrepancy Center header and tab counts; `NO_SUMMARY` (one
   * shared identity) until the first payload lands.
   */
  conflictSummary: DiscrepancySummary
  activity: Activity[]
  /** Concepts that failed to resolve during load (live mode) — shown, not hidden. */
  loadErrors: { concept: string; error: string }[]
  resolvingConflict: string | null
  resolutionError: { message: string; partial: boolean } | null
  discrepancyRules: DiscrepancyRule[]
  discrepancyRuleSuggestions: DiscrepancyRuleSuggestion[]

  setView: (v: ViewId) => void
  setTriageTab: (t: TriageTab) => void
  setSelSignal: (id: string | null) => void
  setSelConflict: (id: string) => void
  setSelConcept: (id: string) => void
  /** Narrow the navigator to one source, or clear it. Leaves the open file alone. */
  setFilesScope: (layer: string | null) => void
  setFilesPath: (path: string | null) => void
  /**
   * Go to Files scoped to a source — the "Browse files" action and its palette
   * twin. `file` (an engine `<layer>/<rel>` path) opens one specific file, for
   * the cross-link from a concept's contributor.
   */
  openFilesScope: (layer: string | null, file?: string | null) => void
  /** Go to Concepts on one concept — the cross-link from the file behind it. */
  openConcept: (id: string) => void
  setQuery: (q: string) => void
  /**
   * Full-text search over section content (GET /api/search), for Knowledge's
   * search box. Live mode only — callers gate on `mode` themselves; calling
   * this in demo mode is a caller bug, not handled here. Never throws: a
   * missing route or any other failure (network, timeout, malformed body)
   * resolves to `null`, the signal to fall back to the substring filter
   * silently rather than break the list.
   */
  search: (query: string, limit?: number) => Promise<SearchHit[] | null>
  openChat: () => void
  closeChat: () => void
  setChatInput: (v: string) => void

  /** Poll again right now — the "Retry now" affordance on the refresh banner. */
  retryNow: () => void
  route: (target: RouteId) => void
  resolveConflict: (conflictId: string, sourceLayer: string, method: 'automatic' | 'manual') => Promise<void>
  resolveSafeConflicts: () => Promise<void>
  decideDiscrepancy: (request: DiscrepancyDecisionRequest) => Promise<void>
  /**
   * Many decisions in one request (POST /api/discrepancy-decisions/batch):
   * one in flight at a time, per-item results, ONE refetch afterwards. Rows
   * whose result is `ok` move status optimistically; a `dryRun` changes
   * nothing here and only answers what would. Rejects on a whole-batch
   * refusal (coverage incomplete, mutations disabled) after recording
   * `resolutionError`, like `decideDiscrepancy`.
   */
  decideDiscrepancies: (request: DiscrepancyBatchRequest) => Promise<DiscrepancyBatchResponse>
  /**
   * Fetch the full record behind a compact discrepancy row (history, full
   * values) and swap it in — bounded LRU, same shape as `loadConceptDetail`.
   * A no-op for rows that already carry their detail.
   */
  loadDiscrepancyDetail: (id: string) => Promise<void>
  approveRuleSuggestion: (id: string) => Promise<void>
  updateDiscrepancyRule: (id: string, changes: { mode?: 'recommend' | 'automatic'; enabled?: boolean }) => Promise<void>
  promoteDiscrepancyRule: (id: string, confirm: boolean) => Promise<Record<string, unknown>>
  setDiscrepancyPriority: (id: string, priority: string) => Promise<void>
  send: (text?: string) => void
  reload: () => void
  /**
   * Bumped by every `reload()`. Exposed because a write can change what a
   * secondary read returns without changing anything visible in `sources` —
   * repointing a source keeps its name, level and count and moves only the
   * folder underneath it. Anything deriving from a separate endpoint keys its
   * refetch on this (see `filesRevalidation` in `layer-files.ts`).
   */
  reloadKey: number
  /**
   * On-demand fetch of the indexing activity feed (rate/ETA, pass history,
   * warnings, engine events). Never part of the poll — call it only while a
   * surface renders it. `null` in demo mode and against engines without the
   * route.
   */
  fetchIndexingActivity: () => Promise<IndexingActivity | null>
  /** Pause/resume/cancel/reindex. Resolves false when the control is unavailable or refused. */
  indexingControl: (action: IndexingControlAction, options?: { source?: string; full?: boolean }) => Promise<boolean>
  /** Whether the backing source supports the indexing controls (live engine only). */
  canControlIndexing: boolean
  /**
   * Rewrite the cascade order — the COMPLETE list of source names, first
   * wins (PUT /api/sources/order). Rejects with the engine's typed error; the
   * caller reloads afterwards, because levels and winners changed. Demo mode
   * rejects with a 405, like every other demo write.
   */
  reorderSources: (order: string[]) => Promise<CascadeOrderResult[]>
}

/** Where the user is. Changes on navigation and selection, never on a keystroke. */
export interface StoreNav {
  view: ViewId
  triageTab: TriageTab
  selSignal: string | null
  selConflict: string
  selConcept: string
  /** Files navigator: the one source it is scoped to, or null for every source. */
  filesScope: string | null
  /** The open file as the engine names it (`<layer>/<rel>`), or null. */
  filesPath: string | null
  /**
   * The Ask panel. Navigation rather than input: the shell reads it to decide
   * what is on screen, and a shell that re-rendered for the chat *composer*
   * would re-render for the search box beside it too.
   */
  chatOpen: boolean
}

/**
 * The toolbar search box. Changes per keystroke — subscribe narrowly, and only
 * where a query actually filters something on screen.
 */
export interface StoreInput {
  query: string
}

/**
 * The Ask panel: what is being typed, what has been said, and whether an answer
 * is in flight. Read by the panel and nothing else — which is the whole point
 * of it being its own context, since the panel renders over a view that must
 * not repaint while a question is being typed into it.
 */
export interface StoreChat {
  chatBusy: boolean
  chatInput: string
  chatMessages: ChatMessage[]
}

export type Store = StoreData & StoreNav & StoreInput & StoreChat

const StoreDataContext = createContext<StoreData | null>(null)
const StoreNavContext = createContext<StoreNav | null>(null)
const StoreInputContext = createContext<StoreInput | null>(null)
const StoreChatContext = createContext<StoreChat | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const source = useMemo(() => createDataSource(), [])
  const mode = source.mode

  const [loading, setLoading] = useState(true)
  const [conceptsLoading, setConceptsLoading] = useState(true)
  const [indexingSources, setIndexingSources] = useState<string[]>([])
  const [tasks, setTasks] = useState<BackgroundTask[]>([])
  const [refreshError, setRefreshError] = useState<LiveDataError | null>(null)
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null)
  const [error, setError] = useState<LiveDataError | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const shellReadyRef = useRef(false)
  // When this console first saw each running task, so the popover can show how
  // long it has been going. The engine reports per-pass elapsed time, which
  // resets across passes; what a waiting user wants is the wall clock.
  const taskStartRef = useRef(new Map<string, number>())
  const pollNowRef = useRef<(() => void) | null>(null)

  const [concepts, setConcepts] = useState<Concept[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  const [conflictSummary, setConflictSummary] = useState<DiscrepancySummary>(NO_SUMMARY)
  const [loadErrors, setLoadErrors] = useState<{ concept: string; error: string }[]>([])
  const [resolvingConflict, setResolvingConflict] = useState<string | null>(null)
  const [resolutionError, setResolutionError] = useState<{ message: string; partial: boolean } | null>(null)
  const [discrepancyRules, setDiscrepancyRules] = useState<DiscrepancyRule[]>([])
  const [discrepancyRuleSuggestions, setDiscrepancyRuleSuggestions] = useState<DiscrepancyRuleSuggestion[]>([])
  // Triage signals and the activity feed have no resolver equivalent — demo-only
  // fixtures (D6: live-mode triage is read-only, and there is no signal API).
  const [signals, setSignals] = useState<Signal[]>(mode === 'demo' ? initialSignals : [])
  // NO_ACTIVITY, not a fresh `[]`: this is a dependency of the `data` memo, so
  // an inline literal gave `data` a new identity on every provider render — and
  // in live mode, which is the only mode that took that branch, that defeated
  // the entire context split. `App` subscribes to `data` and owns every
  // memoized child, so a keystroke anywhere repainted the whole tree in the
  // mode the Mac app ships in, while the demo-mode render tests measured zero.
  const activity = mode === 'demo' ? demoActivity : NO_ACTIVITY

  const initial = useMemo(initialRoute, [])
  const [view, setViewState] = useState<ViewId>(initial.view)
  // Read by `setView` and `setQuery` so both keep a stable identity. An action
  // whose identity changed with the current view would put `view` back into the
  // data context's dependency list, and with it every consumer this split
  // exists to keep out of a navigation render.
  const viewRef = useRef(view); viewRef.current = view
  const [triageTab, setTriageTab] = useState<TriageTab>('review')
  const [selSignal, setSelSignal] = useState<string | null>(mode === 'demo' ? 'sig-1' : null)
  const [selConflict, setSelConflict] = useState('')
  const [selConcept, setSelConceptState] = useState('')
  // A bare #/concepts route can still show the first concept in the desktop
  // split without turning itself into a deep link. An explicit row selection
  // switches the route to the deep-link form.
  const [conceptRouteMode, setConceptRouteMode] = useState<'bare' | 'deep'>(initial.concept ? 'deep' : 'bare')
  const [filesScope, setFilesScopeState] = useState<string | null>(initial.layer ?? null)
  const [filesPath, setFilesPathState] = useState<string | null>(initial.file ?? null)
  // Tell the engine which layer the user has on screen so its indexing queue
  // (packages/core/src/service.mjs) lets that source's pass claim the next
  // free concurrency slot instead of waiting behind ones nobody is looking
  // at. Fire-and-forget — setActiveSource never throws or returns anything
  // this view needs. Guarded the same way `source.search` is just below:
  // several test harnesses stub a partial DataSource with no
  // `setActiveSource` at all, and this effect runs on every mount.
  useEffect(() => {
    if (!source.setActiveSource) return
    source.setActiveSource(filesScope)
  }, [source, filesScope])
  const setSelConcept = useCallback((id: string) => {
    setConceptRouteMode('deep')
    setSelConceptState(id)
  }, [])
  const [queries, setQueries] = useState<Partial<Record<ViewId, string>>>({})
  const query = queries[view] ?? ''
  const setQuery = useCallback((value: string) => setQueries((current) => ({ ...current, [viewRef.current]: value })), [])
  const [chatOpen, setChatOpen] = useState(false)
  const [chatBusy, setChatBusy] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(initialMessages)

  /**
   * Engine status rows → the tasks the UI renders, with a wall clock attached.
   * A source that is `ready` but `refreshing` is a task too: work is happening,
   * and a UI that only counted `indexing` would go blank mid-refresh and look
   * idle while the engine was busy.
   */
  const trackTasks = useCallback((rows: {
    name: string; kind: string; status: string; phase: string
    loaded: number; total: number | null; refreshing: boolean
  }[]): BackgroundTask[] => {
    const now = Date.now()
    const starts = taskStartRef.current
    const active = rows.filter((r) => r.status === 'indexing' || r.refreshing)
    const names = new Set(active.map((r) => r.name))
    for (const key of [...starts.keys()]) if (!names.has(key)) starts.delete(key)
    return active.map((r) => {
      const started = starts.get(r.name) ?? now
      starts.set(r.name, started)
      return {
        name: r.name, kind: r.kind, phase: r.phase, loaded: r.loaded, total: r.total,
        refreshing: r.refreshing, elapsedMs: now - started,
      }
    })
  }, [])

  // ---- Concept details on demand -------------------------------------------
  //
  // Bootstrap builds COMPACT rows from the graph summary (adaptGraphConcept);
  // the full resolve for a concept arrives when it is selected, one
  // /api/resolve at a time. `compactRef` keeps the compact form of every row
  // so an evicted detail can fall back to it instead of to nothing;
  // `loadedDetailsRef` is the LRU order of full details currently held.
  const bucketsRef = useRef<ReturnType<typeof computeSourceBuckets> | null>(null)
  const compactRef = useRef<Map<string, Concept>>(new Map())
  const loadedDetailsRef = useRef<string[]>([])
  const detailInFlightRef = useRef<Set<string>>(new Set())
  // NB: `selConceptRef` (declared with the other selection refs below) is
  // read inside readAll — the binding exists by the time any async pass runs.

  const detailRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadConceptDetail = useCallback(async (id: string) => {
    // Only rows born compact load: demo-bundle rows and the legacy
    // resolve-all fallback are already full, and compactRef only holds rows
    // the graph-first path created.
    if (!compactRef.current.has(id)) return
    if (loadedDetailsRef.current.includes(id)) return
    if (detailInFlightRef.current.has(id)) return
    detailInFlightRef.current.add(id)
    try {
      const resolved = await source.resolve(id)
      const buckets = bucketsRef.current
      if (!buckets || !compactRef.current.has(id)) return // a refetch rebuilt the world mid-flight
      const full = adaptConcept(resolved, buckets)
      const order = loadedDetailsRef.current.filter((held) => held !== id)
      order.push(id)
      // Bounded: the whole point of graph-first is that the renderer never
      // holds the corpus. The oldest detail regresses to its compact row.
      const evict = order.length > DETAIL_CACHE_LIMIT ? order.shift() : undefined
      loadedDetailsRef.current = order
      setConcepts((prev) => prev.map((c) => {
        if (c.id === id) return full
        if (evict !== undefined && c.id === evict) return compactRef.current.get(evict) ?? c
        return c
      }))
    } catch {
      // The compact row stays and the load RETRIES while this concept is
      // still what the user is looking at — the failure window (engine
      // mid-relaunch, a timeout under memory pressure) is exactly the
      // large-vault condition this path exists for, and "a background
      // failure is never silent" means never a permanent spinner either.
      // Selection changes make the retry a no-op; success clears it.
      if (detailRetryRef.current) clearTimeout(detailRetryRef.current)
      detailRetryRef.current = setTimeout(() => {
        detailRetryRef.current = null
        if (selConceptRef.current === id) void loadConceptDetail(id)
      }, 2500)
    } finally {
      detailInFlightRef.current.delete(id)
    }
  }, [source])

  // The detail follows the selection. Runs in the provider (not a view) so
  // every surface that shows the selected concept shares one loader.
  useEffect(() => {
    if (selConcept) void loadConceptDetail(selConcept)
  }, [selConcept, loadConceptDetail])

  // ---- Discrepancy details on demand ------------------------------------------
  //
  // The same shape as concepts. The list is built from COMPACT rows
  // (`?fields=compact`: previews, no history) and the full record for the row
  // on screen arrives on selection through `?id=`. `compactConflictRef` keeps
  // the compact form so an evicted detail regresses to it, and
  // `coverageRef` remembers the payload's coverage flag, which a single
  // record does not carry.
  const compactConflictRef = useRef<Map<string, Conflict>>(new Map())
  const loadedConflictDetailsRef = useRef<string[]>([])
  const conflictDetailInFlightRef = useRef<Set<string>>(new Set())
  const coverageRef = useRef(true)
  // One retry timer per id, cleared on success and on unmount — a single
  // shared timer let a second failing row cancel the first row's retry.
  const conflictDetailRetryRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  useEffect(() => () => {
    for (const timer of conflictDetailRetryRef.current.values()) clearTimeout(timer)
    conflictDetailRetryRef.current.clear()
  }, [])
  const loadDiscrepancyDetail = useCallback(async (id: string) => {
    if (!compactConflictRef.current.has(id)) return
    if (loadedConflictDetailsRef.current.includes(id)) return
    if (conflictDetailInFlightRef.current.has(id)) return
    if (!source.discrepancyDetail) return
    conflictDetailInFlightRef.current.add(id)
    try {
      const record = await source.discrepancyDetail(id)
      const buckets = bucketsRef.current
      if (!buckets || !compactConflictRef.current.has(id)) return // a refetch rebuilt the world mid-flight
      // Gone from the projection between the list and this read (decided
      // elsewhere, or the source moved): leave the compact row; the next
      // refetch drops it. Marking it loaded would show an empty history as
      // if it were the truth.
      if (!record) return
      const full = adaptDiscrepancy(record, coverageRef.current, buckets)
      const pendingRetry = conflictDetailRetryRef.current.get(id)
      if (pendingRetry) { clearTimeout(pendingRetry); conflictDetailRetryRef.current.delete(id) }
      const order = loadedConflictDetailsRef.current.filter((held) => held !== id)
      order.push(id)
      const evict = order.length > DETAIL_CACHE_LIMIT ? order.shift() : undefined
      loadedConflictDetailsRef.current = order
      setConflicts((prev) => prev.map((c) => {
        if (c.id === id) {
          // A decision may have landed on this row while the read was in
          // flight (the optimistic flip in decideDiscrepancy/decideDiscrepancies).
          // The full record is from the same projection as the list, so it can
          // only be older than that flip: keep the flipped status and any
          // decision record the projection has not seen yet. The refetch the
          // decision scheduled settles both a moment later.
          const flipped = c.discrepancyStatus !== full.discrepancyStatus && !isActionable(c)
          if (!flipped) return full
          const unseen = c.history.filter((entry) => !full.history.some((known) => known.id === entry.id))
          return { ...full, discrepancyStatus: c.discrepancyStatus, status: c.status, history: [...full.history, ...unseen] }
        }
        if (evict !== undefined && c.id === evict) return compactConflictRef.current.get(evict) ?? c
        return c
      }))
    } catch {
      // Same retry-while-selected policy as concepts: the compact row stays
      // (a skeleton, never an empty panel) and the load tries again while
      // this row is still the one on screen.
      const previous = conflictDetailRetryRef.current.get(id)
      if (previous) clearTimeout(previous)
      conflictDetailRetryRef.current.set(id, setTimeout(() => {
        conflictDetailRetryRef.current.delete(id)
        if (selConflictRef.current === id) void loadDiscrepancyDetail(id)
      }, 2500))
    } finally {
      conflictDetailInFlightRef.current.delete(id)
    }
  }, [source])

  useEffect(() => {
    if (selConflict) void loadDiscrepancyDetail(selConflict)
  }, [selConflict, loadDiscrepancyDetail])

  // Load the cascade in two stages so the app is usable immediately, then keep
  // the page honest about what the engine is still doing.
  //
  // Stage 1 (the graph) only needs the source topology, which the engine
  // answers from its background index in milliseconds — that unblocks the
  // shell. Stage 2 (resolve-all) fills in concepts and conflicts as they
  // arrive. While the engine is still reading sources it says so, and we poll
  // rather than making the user stare at a blocked screen: that full-page
  // "Resolving the cascade…" wait was the hang people hit on first run.
  //
  // The loop itself polls /api/status — O(sources), sub-millisecond — and pulls
  // the heavy payloads back only when the engine says they would differ. The
  // old loop re-fetched /api/graph *and* /api/resolve-all every 900ms, which on
  // a real vault meant a 620ms, 150MB response for every tick of a counter.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    let running = false
    let generation: number | undefined
    let signature: string | undefined
    // A heavy refetch was attempted and has not landed. The gate below is only
    // ever committed by a readAll that finished, but a signature that flapped
    // back to its previous value would still close it, so the owed refetch is
    // remembered explicitly rather than inferred.
    let refetchOwed = false
    // Flipped off permanently when the engine 404s /api/status — an engine
    // older than this console. Progress then comes off the graph, as before.
    let hasStatusRoute = typeof source.status === 'function'
    // Until the cheap route has actually answered once, the graph is the only
    // thing that knows what is in flight — and the shell needs to say so from
    // the first paint, not from the first poll a second later.
    let statusAnswered = false
    // The last `active` a poll/bootstrap pass computed. Read by onVisibility
    // to decide whether hiding the tab should stop the loop or just slow it
    // down — see schedule() below.
    let activeState = false

    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
    const clearTimer = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined } }
    /**
     * `active` says whether the engine reported work in flight on the pass
     * that's scheduling this tick — not just "not hidden". A hidden window
     * with nothing active has nobody to tell, and visibilitychange resumes
     * the loop when that changes — that cost optimization is unchanged. But
     * a hidden window with work ACTIVE keeps polling anyway, at
     * HIDDEN_ACTIVE_POLL_MS: without this, a tab that went hidden (or was
     * hidden from first paint — see bootstrap's probe) while the engine was
     * still indexing had nothing left to resume it, possibly forever.
     * Demo mode has no engine behind it and nothing that can change either
     * way.
     */
    const schedule = (ms: number, active = false) => {
      clearTimer()
      if (cancelled || source.mode === 'demo') return
      if (hidden()) {
        if (!active) return
        ms = Math.max(ms, HIDDEN_ACTIVE_POLL_MS)
      }
      // Re-checked on fire, not only on schedule: a tick queued a moment
      // before the window was hidden would otherwise still land — unless
      // this tick was itself scheduled to keep running while hidden.
      timer = setTimeout(() => { if (!hidden() || active) void poll() }, ms)
    }

    const applyIndexing = (next: string[]) => {
      setIndexingSources((prev) => (prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next))
    }
    const applyTasks = (next: BackgroundTask[]) => {
      setTasks((prev) => (prev.length === 0 && next.length === 0 ? prev : next))
    }

    /**
     * The heavy pass: graph + resolve-all + resolution history. Throws.
     *
     * `fallbackGeneration` is the number the status poll that triggered this
     * read just saw. It is only used when the graph payload carries none of its
     * own — see the gate at the end.
     */
    const readAll = async (fallbackGeneration?: number): Promise<boolean> => {
      const g = await source.graph()
      if (cancelled) return false
      setSources(adaptSources(g))
      applyIndexing(g.indexingSources ?? [])
      if (!statusAnswered) {
        applyTasks(trackTasks(g.sources.map((s) => ({
          name: s.name, kind: s.kind, status: s.status, phase: s.indexing?.phase ?? 'loading',
          loaded: s.indexing?.loaded ?? 0, total: s.indexing?.total ?? null,
          refreshing: s.indexing?.refreshing === true,
        }))))
      }
      setError(null)
      shellReadyRef.current = true
      setLoading(false) // the shell can render now — everything else streams in

      // Rank-based level→lane buckets for this pass, computed once from every
      // source in the graph that is actually in the cascade (quarantined rows
      // hold no position) and threaded through every adapter below — see
      // computeSourceBuckets in cascade-order.ts for why a narrower or wider
      // computation would bucket the same source differently depending on
      // what happened to touch it.
      const buckets = computeSourceBuckets(g.sources)
      bucketsRef.current = buckets

      // Concepts come from the GRAPH rows — compact identity, lanes and the
      // conflict signal — never from resolve-all. That payload measured
      // ~150MB on a 3,000-note vault, fetched into this renderer on every
      // bootstrap and content move, against a 60s deadline: the "timeout" and
      // the white-window half of the large-vault failure. Full documents now
      // arrive one concept at a time on selection (loadConceptDetail below).
      const [resolutionHistory, discrepancyPayload, rulePayload] = await Promise.all([
        source.conflictResolutions(),
        source.discrepancies ? source.discrepancies() : Promise.resolve(null),
        source.discrepancyRules ? source.discrepancyRules().catch(() => ({ rules: [], suggestions: [] })) : Promise.resolve({ rules: [], suggestions: [] }),
      ])
      if (cancelled) return false
      // Capability is judged by the ANSWER, not only by the method: a live
      // source always defines discrepancies() and returns null when the engine
      // is too old to serve the route (the 404 is swallowed there). Keying the
      // fallback on the method alone left that engine rendering zero conflicts
      // in silence. Either way the legacy whole-corpus path is what answers —
      // an engine that old predates every large-vault feature, so its corpora
      // are small, and it costs one extra round trip there and nowhere else.
      const legacy = discrepancyPayload === null
      const legacyAll = legacy ? await source.resolveAll() : null
      if (cancelled) return false
      const indexing = discrepancyPayload?.indexing ?? legacyAll?.indexing ?? g.indexing ?? false
      const resolvingSources = discrepancyPayload?.indexingSources ?? legacyAll?.indexingSources
      const errors = discrepancyPayload?.errors ?? legacyAll?.errors ?? []
      // Only fail the whole page when nothing is known AND nothing is still
      // being read; a partial pass mid-index is expected, not an error.
      if (g.concepts.length === 0 && errors.length > 0 && !indexing) {
        throw new LiveDataError('bad-shape', `No concept resolved (first error: ${errors[0].concept}: ${errors[0].error})`)
      }
      setLoadErrors(errors)
      // The graph and the payloads above are separate snapshots. Indexing can
      // finish between them; use the later answer so a stale graph never
      // leaves the banner running after the work has landed.
      applyIndexing(indexing ? (resolvingSources ?? g.indexingSources ?? []) : [])
      const rawConflicts = discrepancyPayload
        ? adaptDiscrepancies(discrepancyPayload.discrepancies, discrepancyPayload.coverageComplete, buckets)
        : adaptConflicts(legacyAll?.concepts ?? [], resolutionHistory, buckets)
      // A loaded detail survives a refetch when the compact row says nothing
      // about it moved (same revision, status, history length, owner and
      // priority): the open decision panel — a compose field mid-sentence —
      // must not drop to a skeleton because content moved somewhere else in
      // the corpus. Anything that did move takes the compact row and reloads.
      const previousById = new Map(conflictsRef.current.map((c) => [c.id, c]))
      const carried: string[] = []
      const derivedConflicts = rawConflicts.map((c) => {
        if (c.detailLoaded !== false) return c
        const prev = previousById.get(c.id)
        if (!prev || prev.detailLoaded === false) return c
        const unchanged = prev.revision === c.revision && prev.discrepancyStatus === c.discrepancyStatus
          && prev.history.length === (c.historyCount ?? 0) && prev.priority === c.priority && prev.owner === c.owner
        if (!unchanged) return c
        carried.push(c.id)
        // Only the BODIES and the history come from the old detail — the
        // parts a compact row cannot carry. Everything the fresh row does
        // carry (candidates, the suggested fix, matching rules, health,
        // status) is taken from it: an index pass that added a concept can
        // give a link a new best candidate without touching its revision.
        return {
          ...c,
          contributions: prev.contributions, history: prev.history,
          detailLoaded: prev.detailLoaded, historyCount: undefined, latestDecision: undefined,
        }
      })
      // The engine's summary rides in the compact envelope. An engine that
      // ignored `?fields=compact` (full records, no `summary`), the legacy
      // path and the demo bundle all get the local mirror — same shape, same
      // numbers, so the header does not care which it is drawing from.
      const summary = discrepancyPayload?.summary ?? summarizeConflicts(derivedConflicts)
      const levelBySource = new Map(g.sources.map((s) => [s.name, s.level]))
      const compact = legacy
        ? (legacyAll?.concepts ?? []).map((c) => adaptConcept(c, buckets))
        : g.concepts.map((row) => attachConflictStubs(adaptGraphConcept(row, levelBySource, buckets), derivedConflicts))
      compactRef.current = new Map(compact.map((c) => [c.id, c]))
      loadedDetailsRef.current = []
      // Only rows born compact are detail-loadable; full rows never enter the
      // map — and a carried row keeps its COMPACT form here, so an eviction
      // still has something honest to regress to.
      compactConflictRef.current = new Map(rawConflicts.filter((c) => c.detailLoaded === false).map((c) => [c.id, c]))
      loadedConflictDetailsRef.current = carried
      coverageRef.current = discrepancyPayload?.coverageComplete ?? true
      setConcepts(compact)
      setConflicts(derivedConflicts)
      setConflictSummary(summary)
      setDiscrepancyRules(rulePayload.rules)
      setDiscrepancyRuleSuggestions(rulePayload.suggestions)
      // Honor a deep-linked concept from the URL hash; else default to the
      // first. Only claim the deep link once it actually resolved.
      const pendingId = pendingConceptRef.current
      if (pendingId && compact.some((c) => c.id === pendingId)) {
        setView('concepts')
        setConceptRouteMode('deep')
        setSelConcept(pendingId)
        pendingConceptRef.current = undefined
      } else if (!indexing) {
        setSelConceptState((prev) => prev || compact[0]?.id || '')
        pendingConceptRef.current = undefined
      }
      setSelConflict((prev) => prev || derivedConflicts[0]?.id || '')
      setConceptsLoading(Boolean(indexing))
      // The rows just rebuilt are compact; the concept on screen must not
      // regress to a spinner because content moved somewhere in the corpus.
      const selected = selConceptRef.current
      if (!legacy && selected && compactRef.current.has(selected)) void loadConceptDetail(selected)
      // Same for the discrepancy on screen: its full record reloads behind
      // the rebuilt compact row rather than dropping back to a skeleton.
      const selectedConflict = selConflictRef.current || derivedConflicts[0]?.id
      if (selectedConflict && compactConflictRef.current.has(selectedConflict)) void loadDiscrepancyDetail(selectedConflict)
      // Seed the gate from the payload we just took, so the next poll does not
      // immediately pull the same thing back for a generation it already has.
      // This is the ONLY place the gate advances, and it is past every await:
      // a read that threw leaves the gate where it was, so the next poll owes
      // the same refetch instead of inheriting a success it never had.
      //
      // `graph.generation` is optional on the wire, and an engine that omits it
      // used to leave this at undefined on every pass — `moved` stayed
      // permanently true and a settled app re-read the whole corpus every idle
      // poll. The status route's number is the authority in that case: both
      // routes report the same counter, and it is the one the gate compares
      // against.
      generation = g.generation ?? fallbackGeneration ?? generation
      signature = graphSignature(g)
      refetchOwed = false
      return Boolean(indexing)
    }

    /**
     * One /api/status answer → task/indexing/source state, plus a heavy
     * refetch when the part that decides the payload moved. Shared by the
     * recurring `poll()` below and the one-off bootstrap probe further down,
     * so the gate — "generation moved AND (content signature changed OR
     * nothing in flight)" — is written in exactly one place rather than
     * re-derived, loosely, wherever a status answer needs applying.
     */
    const applyStatus = async (status: StatusSummary): Promise<boolean> => {
      statusAnswered = true
      const rows: SourceStatus[] = status.sources ?? []
      applyIndexing(status.indexingSources ?? [])
      applyTasks(trackTasks(rows))
      // Keep the per-source rows as current as the toolbar. Without this
      // the Sources list holds whatever the last heavy refetch said —
      // which, mid-index, is the phase the source started in.
      setSources((prev) => mergeSourceStatus(prev, rows))
      let active = Boolean(status.indexing) || rows.some((r) => r.refreshing)
      const nextSignature = contentSignature(rows)
      // `generation` also moves for a progress counter. Refetch when the
      // part that decides the payload moved — a snapshot landing, a
      // source erroring, a refresh finishing — or, while the engine is
      // quiet, on any generation change at all (the file-edit case).
      const moved = status.generation !== generation
      const worthRefetching = refetchOwed || (moved && (nextSignature !== signature || !active))
      if (worthRefetching && hidden()) {
        // Owed, but deferred: a hidden tab has no one to show the corpus to,
        // and CLAUDE.md clocks /api/resolve-all at 620ms/150MB on a 3,000-note
        // vault — not a payload to issue on a timer nobody is watching. Mark
        // it owed and leave `generation`/`signature` where they are so the
        // gate stays open (worthRefetching stays true) on every status-only
        // poll while still hidden, then land it in one shot: onVisibility's
        // immediate poll() re-enters this same gate once visible, hidden()
        // is now false, and the branch below actually runs readAll().
        refetchOwed = true
      } else if (worthRefetching) {
        // Committing the gate here — before the heavy read — is how a
        // failed refetch used to hide: the next poll saw nothing moved,
        // skipped the retry, and then took the success path below,
        // clearing the banner over pre-edit concepts. Nothing recovers
        // from that on its own, because contentSignature deliberately
        // excludes document content, so a pure edit never reopens the
        // gate. readAll commits it, once it has actually landed.
        refetchOwed = true
        active = (await readAll(status.generation)) || active
      } else {
        generation = status.generation
        signature = nextSignature
      }
      return active
    }

    /** One cheap poll. Refetches the heavy payloads only when they moved. */
    const poll = async () => {
      if (cancelled || running) return
      running = true
      try {
        let active = false
        if (hasStatusRoute) {
          const status = await source.status()
          if (cancelled) return
          if (status === null) hasStatusRoute = false
          else active = await applyStatus(status)
        }
        if (!hasStatusRoute) active = await readAll()
        if (cancelled) return
        failures = 0
        setRefreshError(null)
        setLastRefreshAt(Date.now())
        activeState = active
        schedule(active ? ACTIVE_POLL_MS : IDLE_POLL_MS, active)
      } catch (e) {
        if (cancelled) return
        // Never give up, and never quietly retract what the page is saying.
        // This used to stop after three failures and clear `indexingSources`,
        // which left a page that had silently stopped updating and no way for
        // anyone to know — the exact impression this whole pass exists to fix.
        failures += 1
        setRefreshError(asLiveDataError(e))
        // A failure tells us nothing about whether work is still in flight —
        // it is not evidence of "active", so it must not keep a HIDDEN tab
        // polling forever off a stale `true` from the last successful pass.
        // (Measured before this fix: 85 failed fetches in 10 simulated hidden
        // minutes, no termination.) A VISIBLE tab is unaffected: schedule()
        // always fires its next tick when the tab isn't hidden, regardless of
        // `active` — only the hidden branch reads this value at all.
        activeState = false
        schedule(Math.min(MAX_BACKOFF_MS, ACTIVE_POLL_MS * failures), activeState)
      } finally {
        running = false
      }
    }

    const bootstrap = async () => {
      running = true
      try {
        let active = await readAll()
        if (cancelled) return
        setRefreshError(null)
        setLastRefreshAt(Date.now())
        // A page that first renders with document.visibilityState === 'hidden'
        // (embedded webviews can misreport this) is exactly the case
        // schedule()'s HIDDEN_ACTIVE_POLL_MS branch exists for: if the engine
        // is still indexing at this instant — the common case on a large
        // vault — a plain schedule(active) below would go silent forever
        // while hidden, because active only reflects readAll()'s snapshot,
        // taken before this probe. So this one extra probe runs regardless
        // of hidden(), through the exact gate `poll()` uses (applyStatus),
        // so it only pays for a heavy refetch when that gate says one is
        // owed — and its OWN answer (not the earlier readAll()'s) is what
        // schedule() below acts on, so work that started between the two
        // calls is scheduled at ACTIVE_POLL_MS instead of IDLE_POLL_MS.
        // Demo mode never probes — there is no engine behind it to ask.
        if (source.mode === 'live' && hasStatusRoute) {
          try {
            const status = await source.status()
            if (!cancelled) {
              if (status === null) hasStatusRoute = false
              else active = await applyStatus(status)
            }
          } catch {
            // Non-fatal: readAll() above already left a good snapshot up, and
            // the recurring loop retries on its own once it gets to run.
          }
        }
        activeState = active
        schedule(active ? ACTIVE_POLL_MS : IDLE_POLL_MS, active)
      } catch (e) {
        if (cancelled) return
        // A failure on a background refresh must not blow away a working page;
        // only a failed first bootstrap owns the full-page error state.
        if (!shellReadyRef.current) {
          setError(asLiveDataError(e))
          setLoading(false)
          setConceptsLoading(false)
          return
        }
        failures += 1
        setRefreshError(asLiveDataError(e))
        // Same reasoning as poll()'s catch: a failure is not evidence of
        // active work, so it must not keep a hidden tab polling forever.
        activeState = false
        schedule(Math.min(MAX_BACKOFF_MS, ACTIVE_POLL_MS * failures), activeState)
      } finally {
        running = false
      }
    }

    const onVisibility = () => {
      if (hidden()) {
        // Nothing active: go fully silent, same as before — the whole point
        // of the cost optimization. Something active: re-schedule rather
        // than clear, so the loop drops straight to HIDDEN_ACTIVE_POLL_MS
        // instead of continuing to fire at the visible cadence until its
        // already-queued tick happens to land.
        if (activeState) schedule(ACTIVE_POLL_MS, true)
        else clearTimer()
      } else {
        schedule(0, activeState)
      }
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    // An explicit user retry (the refresh-error banner) always fires
    // immediately, hidden tab or not — it's a direct request, not the
    // passive background loop the hidden-tab cadence rules are about.
    pollNowRef.current = () => { failures = 0; schedule(0, true) }

    // A refresh must not replace an already-usable shell with a full-page
    // loader. Besides the visual regression, doing so unmounts the Files editor
    // and can discard an unsaved draft. Only the initial bootstrap owns the
    // shell-level loading state.
    if (!shellReadyRef.current) setLoading(true)
    setConceptsLoading(true)
    setError(null)
    void bootstrap()
    return () => {
      cancelled = true
      clearTimer()
      pollNowRef.current = null
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [source, reloadKey, trackTasks])

  // Refs so callbacks read the freshest values without re-subscribing.
  const queryRef = useRef(query); queryRef.current = query
  const triageTabRef = useRef(triageTab); triageTabRef.current = triageTab
  const signalsRef = useRef(signals); signalsRef.current = signals
  const selSignalRef = useRef(selSignal); selSignalRef.current = selSignal
  const selConflictRef = useRef(selConflict); selConflictRef.current = selConflict
  const selConceptRef = useRef(selConcept); selConceptRef.current = selConcept
  const conceptRouteModeRef = useRef(conceptRouteMode); conceptRouteModeRef.current = conceptRouteMode
  const filesScopeRef = useRef(filesScope); filesScopeRef.current = filesScope
  const filesPathRef = useRef(filesPath); filesPathRef.current = filesPath
  const chatBusyRef = useRef(chatBusy); chatBusyRef.current = chatBusy
  const chatInputRef = useRef(chatInput); chatInputRef.current = chatInput
  const conceptsRef = useRef(concepts); conceptsRef.current = concepts
  const conflictsRef = useRef(conflicts); conflictsRef.current = conflicts
  const resolvingConflictRef = useRef<string | null>(null)
  const modeRef = useRef(mode); modeRef.current = mode
  const pendingConceptRef = useRef<string | undefined>(initial.concept)
  const prevViewRef = useRef<ViewId>(view)

  const setView = useCallback((next: ViewId) => {
    if (next === viewRef.current) return
    if (!dispatchNavigationGuard()) return
    if (next === 'concepts') setConceptRouteMode('bare')
    setViewState(next)
  }, [])

  const setFilesScope = useCallback((layer: string | null) => setFilesScopeState(layer), [])
  const setFilesPath = useCallback((path: string | null) => setFilesPathState(path), [])

  /**
   * "Browse files in <source>". Runs the navigation guard itself rather than
   * going through setView, which would ask a second time — and drops an open
   * file that belongs to a different source, so the navigator and the editor
   * never disagree about which source you are looking at.
   *
   * `file` is the engine's own `<layer>/<rel>` path, for arriving at one
   * specific file (a concept's "open file" link). Passing one from another
   * source is a caller bug, so it is ignored rather than silently changing the
   * scope out from under the navigator.
   */
  const openFilesScope = useCallback((layer: string | null, file?: string | null) => {
    if (!dispatchNavigationGuard()) return
    setFilesScopeState(layer)
    const wanted = file && (!layer || file.startsWith(`${layer}/`)) ? file : null
    if (wanted) setFilesPathState(wanted)
    else setFilesPathState((current) => (layer && current && !current.startsWith(`${layer}/`) ? null : current))
    setViewState('files')
  }, [])

  /**
   * "Open the concept behind this file" — the mirror of openFilesScope, and
   * guarded once for the same reason: setView would ask about unsaved changes,
   * and then setSelConcept would have already moved the selection whether the
   * user said yes or not.
   */
  const openConcept = useCallback((id: string) => {
    if (!dispatchNavigationGuard()) return
    setConceptRouteMode('deep')
    setSelConceptState(id)
    setViewState('concepts')
  }, [])

  useEffect(() => {
    document.title = titleForView(view)
  }, [view])

  useEffect(() => {
    window.__CC_DESKTOP?.uiState?.set({
      lastView: view,
      ...(view === 'concepts' || view === 'files' ? { knowledgeView: view } : {}),
      ...(view === 'triage' || view === 'conflicts' ? { reviewView: view } : {}),
    }).catch(() => {})
    if (!window.__CC_DESKTOP) {
      try {
        localStorage.setItem(BROWSER_LAST_VIEW_KEY, view)
        if (view === 'concepts' || view === 'files') localStorage.setItem(BROWSER_KNOWLEDGE_VIEW_KEY, view)
        if (view === 'triage' || view === 'conflicts') localStorage.setItem(BROWSER_REVIEW_VIEW_KEY, view)
      } catch { /* browser storage is optional */ }
    }
  }, [view])

  /**
   * The hash that describes what is on screen right now — the one place that
   * knows how each view addresses itself. Read through refs so the popstate
   * handler (which only re-subscribes on `view`) can call it without ever
   * restoring a stale URL.
   */
  const currentHash = useCallback((): string => {
    if (view === 'files') return filesHash(filesScopeRef.current, filesPathRef.current)
    if (view === 'concepts' && selConceptRef.current && conceptRouteModeRef.current === 'deep') {
      return `#/concepts/${encodeURIComponent(selConceptRef.current)}`
    }
    return `#/${view}`
  }, [view])

  // URL hash ⇄ state: reflect view/selected-concept for deep links, restore on
  // load (above), and support back/forward. pushState on view change (a real
  // navigation), replaceState within a view (selection tweak) to avoid spam.
  useEffect(() => {
    // While a deep-linked concept is still pending (loading, or load failed),
    // leave the URL alone — rewriting it here would permanently clobber the
    // deep link before the data arrives to honor it.
    if (pendingConceptRef.current) return
    const target = currentHash()
    if (window.location.hash === target) { prevViewRef.current = view; return }
    const viewChanged = prevViewRef.current !== view
    prevViewRef.current = view
    if (viewChanged) window.history.pushState(null, '', target)
    else window.history.replaceState(null, '', target)
  }, [conceptRouteMode, currentHash, view, selConcept, filesScope, filesPath])

  useEffect(() => {
    const onPop = () => {
      const p = parseHash(window.location.hash)
      if (!p.view) return
      // What the entry would OPEN, not merely which view it names. Two adjacent
      // #/files entries share a view and differ in the document, and an unsaved
      // draft belongs to the document — gating the guard on the view alone let
      // Back walk between two Files URLs and discard typed text with no prompt
      // at all. Nothing prompts unless something is dirty: the guard is a
      // cancelable event and the editor only listens while it holds edits.
      const movesFile = p.view === 'files' && (p.file ?? null) !== filesPathRef.current
      if (p.view !== view || movesFile) {
        if (!dispatchNavigationGuard()) {
          // Put the screen the user is still on back on top of the stack —
          // pushState, and the *whole* URL (scope and open file included), not
          // `#/${view}`. The popstate has already moved the session onto the
          // NEIGHBOURING entry, so replacing "the current entry" would rewrite
          // the page they came from: Back would then lead back here instead of
          // where they actually were, and a reload would land on a URL that no
          // longer describes the screen.
          window.history.pushState(null, '', currentHash())
          return
        }
        setViewState(p.view)
      }
      // A bare Concepts route is a real stable URL, not an alias for whichever
      // concept happened to be selected before Back/Forward. Clear the prior
      // deep-link selection so the URL effect cannot rewrite history.
      if (p.view === 'concepts') {
        setConceptRouteMode(p.concept ? 'deep' : 'bare')
        setSelConceptState(p.concept ?? conceptsRef.current[0]?.id ?? '')
      }
      // Back/Forward across the Files route restores exactly what the hash
      // says, scope included — a bare #/files really means "every source".
      if (p.view === 'files') {
        setFilesScopeState(p.layer ?? null)
        setFilesPathState(p.file ?? null)
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [currentHash, view])

  const route = useCallback((target: RouteId) => {
    if (modeRef.current !== 'demo') return // live triage is read-only (D6)
    const sig = signalsRef.current.find((s) => s.id === selSignalRef.current)
    if (!sig) return

    // An action, not a render: reading the freshest query off the ref is the
    // point here, because the keyboard shortcut fires outside the view.
    const currentTab = triageTabRef.current
    const currentRoute = TAB_TO_ROUTE[currentTab]
    const q = queryRef.current
    const before = filterSignals(signalsRef.current, currentTab, q)
    const pos = before.findIndex((s) => s.id === sig.id)

    const nextSignals = signalsRef.current.map((s) => (s.id === sig.id ? { ...s, route: target } : s))
    signalsRef.current = nextSignals
    setSignals(nextSignals)

    const after = filterSignals(nextSignals, currentTab, q)
    const stayed = target === currentRoute
    const next = stayed
      ? after[pos + 1] ?? after[pos] ?? null
      : after[pos] ?? after[after.length - 1] ?? null
    setSelSignal(next ? next.id : null)
  }, [])

  const applyResolution = useCallback(async (
    conflict: Conflict,
    sourceLayer: string,
    method: 'automatic' | 'manual',
  ) => {
    const latest = conflict.history[conflict.history.length - 1]
    const record = await source.resolveConflict({
      conceptId: conflict.concept,
      sectionKey: conflict.sectionKey,
      selectedLayer: sourceLayer,
      method,
      ...(conflict.status === 'resolved' && latest ? { resolutionId: latest.id } : {}),
    })
    setConflicts((prev) => prev.map((item) => item.id === conflict.id
      ? {
          ...item,
          status: 'resolved',
          winner: item.contributions.find((entry) => entry.sourceLayer === sourceLayer)?.layer ?? item.winner,
          history: [...item.history, record],
        }
      : item))
    return record
  }, [source])

  const resolveConflict = useCallback(async (conflictId: string, sourceLayer: string, method: 'automatic' | 'manual') => {
    const conflict = conflictsRef.current.find((item) => item.id === conflictId)
    if (!conflict || resolvingConflictRef.current) return
    resolvingConflictRef.current = conflictId
    setResolvingConflict(conflictId)
    setResolutionError(null)
    try {
      await applyResolution(conflict, sourceLayer, method)
      // Let the source watcher/index begin before refreshing the full cascade.
      window.setTimeout(() => setReloadKey((key) => key + 1), 300)
    } catch (error) {
      setResolutionError({ message: error instanceof Error ? error.message : String(error), partial: false })
      throw error
    } finally {
      resolvingConflictRef.current = null
      setResolvingConflict(null)
    }
  }, [applyResolution])

  const resolveSafeConflicts = useCallback(async () => {
    if (resolvingConflictRef.current) return
    const safe = conflictsRef.current.filter((item) => item.status === 'open' && item.safe)
    if (!safe.length) return
    resolvingConflictRef.current = 'safe-batch'
    setResolvingConflict('safe-batch')
    setResolutionError(null)
    let resolvedCount = 0
    try {
      for (const conflict of safe) {
        const current = conflict.contributions[0]
        await applyResolution(conflict, current.sourceLayer, 'automatic')
        resolvedCount += 1
      }
      window.setTimeout(() => setReloadKey((key) => key + 1), 300)
    } catch (error) {
      setResolutionError({ message: error instanceof Error ? error.message : String(error), partial: resolvedCount > 0 })
    } finally {
      resolvingConflictRef.current = null
      setResolvingConflict(null)
    }
  }, [applyResolution])

  const decideDiscrepancy = useCallback(async (request: DiscrepancyDecisionRequest) => {
    // Refused, not ignored: a caller that awaited `undefined` here used to go
    // on to show a "Done" receipt for a decision that never happened.
    if (resolvingConflictRef.current) {
      const error = new Error('Another decision is still being applied.')
      setResolutionError({ message: error.message, partial: false })
      throw error
    }
    resolvingConflictRef.current = request.discrepancyId
    setResolvingConflict(request.discrepancyId)
    setResolutionError(null)
    try {
      const record = await source.decideDiscrepancy(request)
      // The header count and the tab counts read the summary, so the flip
      // recomputes it locally; the refetch a moment later overwrites it with
      // the engine's numbers.
      const next = conflictsRef.current.map((item) => item.id === request.discrepancyId
        ? { ...item, status: request.action === 'acknowledge' ? 'open' as const : 'resolved' as const, discrepancyStatus: request.action === 'acknowledge' ? 'acknowledged' as const : 'resolved' as const, history: [...item.history, record] }
        : item)
      conflictsRef.current = next
      setConflicts(next)
      setConflictSummary(summarizeConflicts(next))
      window.setTimeout(() => setReloadKey((key) => key + 1), 300)
    } catch (error) {
      setResolutionError({ message: error instanceof Error ? error.message : String(error), partial: false })
      throw error
    } finally {
      resolvingConflictRef.current = null
      setResolvingConflict(null)
    }
  }, [source])

  /** The batch marker in `resolvingConflict` while a bulk decision is in flight. */
  const BATCH_MARKER = 'batch'
  const decideDiscrepancies = useCallback(async (request: DiscrepancyBatchRequest): Promise<DiscrepancyBatchResponse> => {
    if (resolvingConflictRef.current) throw new Error('Another decision is still being applied.')
    resolvingConflictRef.current = BATCH_MARKER
    setResolvingConflict(BATCH_MARKER)
    setResolutionError(null)
    try {
      // Several test harnesses stub a partial DataSource with no batch method,
      // and an engine older than the route answers 404 inside the real one —
      // both land on the same one-at-a-time loop.
      const response = source.decideDiscrepancies
        ? await source.decideDiscrepancies(request)
        : await runSequentially(request, (decision) => source.decideDiscrepancy(decision))
      if (!request.dryRun && response.results.length > 0) {
        const byId = new Map(request.decisions.map((decision) => [decision.discrepancyId, decision]))
        const landed = new Map(response.results.filter((result) => result.ok && result.discrepancyId).map((result) => [result.discrepancyId as string, result]))
        if (landed.size > 0) {
          const next = conflictsRef.current.map((item) => {
            const result = landed.get(item.id)
            const decision = byId.get(item.id)
            if (!result || !decision) return item
            const acknowledged = decision.action === 'acknowledge'
            return {
              ...item,
              status: acknowledged ? 'open' as const : 'resolved' as const,
              discrepancyStatus: acknowledged ? 'acknowledged' as const : 'resolved' as const,
              history: result.decision ? [...item.history, result.decision] : item.history,
            }
          })
          conflictsRef.current = next
          setConflicts(next)
          setConflictSummary(summarizeConflicts(next))
        }
        // ONE refetch for the whole batch — not one per result — and even
        // when nothing landed: a batch that came back all STALE / NOT_OPEN
        // (rows decided by another client or by the engine's automatic
        // rules, neither of which moves `generation`) is holding revisions
        // the engine no longer has, and "failures stay selected" would retry
        // them forever without this.
        window.setTimeout(() => setReloadKey((key) => key + 1), 300)
      }
      return response
    } catch (error) {
      setResolutionError({ message: error instanceof Error ? error.message : String(error), partial: false })
      throw error
    } finally {
      resolvingConflictRef.current = null
      setResolvingConflict(null)
    }
  }, [source])

  const approveRuleSuggestion = useCallback(async (id: string) => {
    const rule = await source.createDiscrepancyRule(id)
    setDiscrepancyRules((items) => [...items, rule])
    setDiscrepancyRuleSuggestions((items) => items.filter((item) => item.id !== id))
    setReloadKey((key) => key + 1)
  }, [source])

  const updateDiscrepancyRule = useCallback(async (id: string, changes: { mode?: 'recommend' | 'automatic'; enabled?: boolean }) => {
    const rule = await source.patchDiscrepancyRule(id, changes)
    setDiscrepancyRules((items) => items.map((item) => item.id === id ? rule : item))
    setReloadKey((key) => key + 1)
  }, [source])

  const promoteDiscrepancyRule = useCallback((id: string, confirm: boolean) => source.promoteDiscrepancyRule(id, confirm), [source])
  const setDiscrepancyPriority = useCallback(async (id: string, priority: string) => {
    await source.setDiscrepancyPriority(id, priority)
    setConflicts((items) => items.map((item) => item.id === id ? { ...item, priority } : item))
  }, [source])

  const send = useCallback((text?: string) => {
    const q = (text != null ? text : chatInputRef.current).trim()
    if (!q || chatBusyRef.current) return
    setChatMessages((prev) => [...prev, { role: 'user', text: q }])
    setChatInput('')
    setChatBusy(true)
    chatBusyRef.current = true

    const finishCanned = () => {
      const a = cannedAnswer(q)
      setChatMessages((prev) => [...prev, { role: 'assistant', canned: true, ...a }])
      setChatBusy(false)
      chatBusyRef.current = false
    }

    const finishUnavailable = () => {
      setChatMessages((prev) => [...prev, {
        role: 'assistant',
        text: 'I could not reach a connected agent, so I did not generate an answer. Reconnect your AI client and try again.',
      }])
      setChatBusy(false)
      chatBusyRef.current = false
    }

    const complete = window.claude?.complete
    if (complete) {
      const prompt = `You are ContextCake, an assistant that answers ONLY from a team's resolved knowledge cascade (Personal, Team, Company layers in that order of precedence; an earlier layer overrides a later one per section). Answer the question in 1-3 sentences, plainly. If layers disagree, say which layer wins.\n\nCASCADE:\n${buildContext(conceptsRef.current)}\n\nQUESTION: ${q}`
      complete(prompt)
        .then((ans) => {
          setChatMessages((prev) => [...prev, { role: 'assistant', text: (ans || '').trim() }])
          setChatBusy(false)
          chatBusyRef.current = false
        })
        .catch(source.mode === 'demo' ? finishCanned : finishUnavailable)
    } else if (source.mode === 'demo') {
      setTimeout(finishCanned, 620)
    } else {
      finishUnavailable()
    }
  }, [source.mode])

  // `source.search` is on the DataSource interface, but several test harnesses
  // stub a partial DataSource (see store.test.tsx) with no `search` at all —
  // same reason `source.discrepancies` above is guarded rather than called
  // directly. Any rejection (network, timeout, a malformed body) is caught
  // here too: this is the one place that owns "never break the list",
  // regardless of which layer the failure came from.
  const search = useCallback(async (query: string, limit?: number): Promise<SearchHit[] | null> => {
    if (!source.search) return null
    try {
      return await source.search(query, limit)
    } catch {
      return null
    }
  }, [source])

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])
  const openChat = useCallback(() => setChatOpen(true), [])
  const closeChat = useCallback(() => setChatOpen(false), [])
  // Kicks the live poll rather than remounting the effect: a reload() here
  // would drop back through the shell-loading path and unmount open editors.
  const retryNow = useCallback(() => {
    if (pollNowRef.current) pollNowRef.current()
    else setReloadKey((k) => k + 1)
  }, [])

  // The power-user indexing surfaces. Activity is fetched ON DEMAND by the
  // component that renders it (never part of the steady-state poll), and a
  // control kicks the poll so the affected rows repaint promptly. Both are
  // absent-by-capability: demo mode and old engines simply have no panel.
  const fetchIndexingActivity = useCallback(async () => {
    if (!source.indexingActivity) return null
    try { return await source.indexingActivity() } catch { return null }
  }, [source])
  const indexingControl = useCallback(async (action: IndexingControlAction, options: { source?: string; full?: boolean } = {}) => {
    if (!source.indexingControl) return false
    try {
      const ok = await source.indexingControl(action, options)
      if (pollNowRef.current) pollNowRef.current()
      return ok
    } catch {
      return false
    }
  }, [source])
  const canControlIndexing = typeof source.indexingControl === 'function'
  // Guarded like `source.search`: the partial DataSource stubs in the test
  // harnesses predate the route. Deliberately does NOT reload — the Sources
  // view already reloads once after a save that may have PATCHed first, and
  // a second bump here would refetch the graph twice for one edit.
  const reorderSources = useCallback(async (order: string[]) => {
    if (!source.reorderSources) throw new LiveDataError('bad-status', 'This engine cannot reorder sources.', 405)
    return source.reorderSources(order)
  }, [source])

  const load = useMemo<LoadState>(
    () => ({ shell: loading, concepts: conceptsLoading, indexingSources, tasks, refreshError, lastRefreshAt }),
    [loading, conceptsLoading, indexingSources, tasks, refreshError, lastRefreshAt],
  )

  const data = useMemo<StoreData>(() => ({
    mode, loading, load, error,
    concepts, sources, signals, conflicts, conflictSummary, activity, loadErrors, resolvingConflict, resolutionError,
    discrepancyRules, discrepancyRuleSuggestions,
    setView, setTriageTab, setSelSignal, setSelConflict, setSelConcept, setQuery, search,
    setFilesScope, setFilesPath, openFilesScope, openConcept,
    openChat, closeChat, setChatInput,
    retryNow, route, resolveConflict, resolveSafeConflicts, decideDiscrepancy, decideDiscrepancies, loadDiscrepancyDetail,
    approveRuleSuggestion, updateDiscrepancyRule, promoteDiscrepancyRule, setDiscrepancyPriority,
    send, reload, reloadKey,
    fetchIndexingActivity, indexingControl, canControlIndexing, reorderSources,
  }), [mode, loading, load, error, concepts, sources, signals, conflicts, conflictSummary, activity, loadErrors,
    resolvingConflict, resolutionError, discrepancyRules, discrepancyRuleSuggestions,
    retryNow, route, resolveConflict, resolveSafeConflicts, decideDiscrepancy, decideDiscrepancies, loadDiscrepancyDetail,
    approveRuleSuggestion, updateDiscrepancyRule, promoteDiscrepancyRule, setDiscrepancyPriority,
    send, reload, reloadKey, setView, setSelConcept, setQuery, search, setFilesScope, setFilesPath,
    openFilesScope, openConcept, openChat, closeChat,
    fetchIndexingActivity, indexingControl, canControlIndexing, reorderSources])

  const nav = useMemo<StoreNav>(
    () => ({ view, triageTab, selSignal, selConflict, selConcept, filesScope, filesPath, chatOpen }),
    [view, triageTab, selSignal, selConflict, selConcept, filesScope, filesPath, chatOpen],
  )

  const input = useMemo<StoreInput>(() => ({ query }), [query])

  const chat = useMemo<StoreChat>(
    () => ({ chatBusy, chatInput, chatMessages }),
    [chatBusy, chatInput, chatMessages],
  )

  return (
    <StoreDataContext.Provider value={data}>
      <StoreNavContext.Provider value={nav}>
        <StoreInputContext.Provider value={input}>
          <StoreChatContext.Provider value={chat}>{children}</StoreChatContext.Provider>
        </StoreInputContext.Provider>
      </StoreNavContext.Provider>
    </StoreDataContext.Provider>
  )
}

function required<T>(ctx: T | null, name: string): T {
  if (!ctx) throw new Error(`${name} must be used within StoreProvider`)
  return ctx
}

/** Engine answers and every action. Does not re-render on navigation or typing. */
export function useStoreData(): StoreData {
  return required(useContext(StoreDataContext), 'useStoreData')
}

/** Current view and selection. Does not re-render on typing. */
export function useStoreNav(): StoreNav {
  return required(useContext(StoreNavContext), 'useStoreNav')
}

/** The toolbar search box. Re-renders per keystroke — subscribe last. */
export function useStoreInput(): StoreInput {
  return required(useContext(StoreInputContext), 'useStoreInput')
}

/**
 * The Ask panel's own state. Re-renders per keystroke in the composer, so this
 * belongs to the panel — a view that reaches for it signs itself up to repaint
 * while someone types a question over the top of it.
 */
export function useStoreChat(): StoreChat {
  return required(useContext(StoreChatContext), 'useStoreChat')
}

/**
 * All four at once. Convenient, and correspondingly expensive: a consumer of
 * this re-renders on every keystroke in either typing surface, whether or not
 * it reads either one. Reach for the narrow hooks in anything that renders more
 * than a few nodes.
 */
export function useStore(): Store {
  const data = useStoreData()
  const nav = useStoreNav()
  const input = useStoreInput()
  const chat = useStoreChat()
  return useMemo(() => ({ ...data, ...nav, ...input, ...chat }), [data, nav, input, chat])
}
