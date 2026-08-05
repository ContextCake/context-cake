import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react'
import {
  activity as demoActivity, initialSignals,
  type Activity, type Concept, type Conflict, type Signal, type Source,
} from './data'
import {
  adaptConcept, adaptConflicts, adaptSources, createDataSource, LiveDataError, type Mode,
} from './api'
import type { LayerId, RouteId } from './theme'
import { dispatchNavigationGuard, isViewId, parseHash, type ViewId } from './shell-navigation'

export type { ViewId } from './shell-navigation'
export type TriageTab = 'review' | 'captured' | 'ignored'

const BROWSER_LAST_VIEW_KEY = 'contextcake.lastView'
const BROWSER_KNOWLEDGE_VIEW_KEY = 'contextcake.knowledgeView'
const BROWSER_REVIEW_VIEW_KEY = 'contextcake.reviewView'

function initialRoute(): { view: ViewId; concept?: string } {
  if (typeof window === 'undefined') return { view: 'overview' }
  const explicit = parseHash(window.location.hash)
  if (explicit.view) return { view: explicit.view, concept: explicit.concept }
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

const initialMessages: ChatMessage[] = [
  { role: 'assistant', intro: true, text: "Ask me anything about your team's knowledge. I read the resolved cascade — Company, Team, and your Personal layer — and tell you which layer each answer comes from." },
]

declare global {
  interface Window {
    claude?: { complete?: (prompt: string) => Promise<string> }
  }
}

const TAB_TO_ROUTE: Record<TriageTab, RouteId> = {
  review: 'review_required', captured: 'team_candidate', ignored: 'ignore',
}

/** A compact textual view of the resolved cascade, for the chat prompt. */
function buildContext(concepts: Concept[]): string {
  return concepts
    .map((c) => `${c.id}: ` + c.sections
      .map((s) => `${s.name} = "${s.value}" [${s.winner}]`
        + (s.dissents ?? []).map((d) => ` (conflicts with ${d.layer}: "${d.value}")`).join(''))
      .join('; '))
    .join('\n')
}

function cannedAnswer(q: string): { text: string; cites: Cite[]; note?: string } {
  const s = q.toLowerCase()
  if (/(jwt|audience|auth|token)/.test(s)) return { text: 'For internal service-to-service calls, the JWT audience is "internal.acme.com".', cites: [{ layer: 'team', label: 'Team · interfaces/auth-tokens' }], note: 'The Company contract still says "api.acme.com" for external clients — surfaced as a conflict.' }
  if (/(on.?call|escalat|page|incident)/.test(s)) return { text: 'Company policy is to page the platform on-call, then the EM. A personal override can point at a specific owner first.', cites: [{ layer: 'company', label: 'Company · runbooks/incident-response' }], note: 'Higher layers override per section; the rest is inherited.' }
  if (/(deploy|release|ship)/.test(s)) return { text: 'Deploys go through the team runbook — staged rollout with health checks between steps.', cites: [{ layer: 'team', label: 'Team · runbooks/deploy' }] }
  if (/(database|db|postgres|store|singlestore)/.test(s)) return { text: 'The team runs SingleStore for the primary database — chosen for HTAP workloads.', cites: [{ layer: 'team', label: 'Team · decisions/primary-db' }], note: 'Overrides the Company default (Postgres) for the Engine section only.' }
  return { text: 'I resolved that across all three layers but found nothing specific. Try asking about the database, auth tokens, deploys, or incident response.', cites: [] }
}

/** What the shell is waiting on. `shell` is the only state that blocks the UI. */
export interface LoadState {
  /** True only until the source topology is known — milliseconds, not minutes. */
  shell: boolean
  /** True while concepts are still being resolved in the background. */
  concepts: boolean
  /** Sources the engine is still reading. */
  indexingSources: string[]
}

export interface Store {
  mode: Mode
  loading: boolean
  load: LoadState
  error: LiveDataError | null

  view: ViewId
  triageTab: TriageTab
  selSignal: string | null
  selConflict: string
  selConcept: string
  query: string
  chatOpen: boolean
  chatBusy: boolean
  chatInput: string
  chatMessages: ChatMessage[]

  concepts: Concept[]
  sources: Source[]
  signals: Signal[]
  conflicts: Conflict[]
  activity: Activity[]
  /** Concepts that failed to resolve during load (live mode) — shown, not hidden. */
  loadErrors: { concept: string; error: string }[]
  resolvingConflict: string | null
  resolutionError: { message: string; partial: boolean } | null

  setView: (v: ViewId) => void
  setTriageTab: (t: TriageTab) => void
  setSelSignal: (id: string | null) => void
  setSelConflict: (id: string) => void
  setSelConcept: (id: string) => void
  setQuery: (q: string) => void
  openChat: () => void
  closeChat: () => void
  setChatInput: (v: string) => void

  filtered: (tab: TriageTab) => Signal[]
  route: (target: RouteId) => void
  resolveConflict: (conflictId: string, sourceLayer: string, method: 'automatic' | 'manual') => Promise<void>
  resolveSafeConflicts: () => Promise<void>
  send: (text?: string) => void
  reload: () => void
}

const StoreContext = createContext<Store | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const source = useMemo(() => createDataSource(), [])
  const mode = source.mode

  const [loading, setLoading] = useState(true)
  const [conceptsLoading, setConceptsLoading] = useState(true)
  const [indexingSources, setIndexingSources] = useState<string[]>([])
  const [error, setError] = useState<LiveDataError | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const shellReadyRef = useRef(false)

  const [concepts, setConcepts] = useState<Concept[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  const [loadErrors, setLoadErrors] = useState<{ concept: string; error: string }[]>([])
  const [resolvingConflict, setResolvingConflict] = useState<string | null>(null)
  const [resolutionError, setResolutionError] = useState<{ message: string; partial: boolean } | null>(null)
  // Triage signals and the activity feed have no resolver equivalent — demo-only
  // fixtures (D6: live-mode triage is read-only, and there is no signal API).
  const [signals, setSignals] = useState<Signal[]>(mode === 'demo' ? initialSignals : [])
  const activity = mode === 'demo' ? demoActivity : []

  const initial = useMemo(initialRoute, [])
  const [view, setViewState] = useState<ViewId>(initial.view)
  const [triageTab, setTriageTab] = useState<TriageTab>('review')
  const [selSignal, setSelSignal] = useState<string | null>(mode === 'demo' ? 'sig-1' : null)
  const [selConflict, setSelConflict] = useState('')
  const [selConcept, setSelConceptState] = useState('')
  // A bare #/concepts route can still show the first concept in the desktop
  // split without turning itself into a deep link. An explicit row selection
  // switches the route to the deep-link form.
  const [conceptRouteMode, setConceptRouteMode] = useState<'bare' | 'deep'>(initial.concept ? 'deep' : 'bare')
  const setSelConcept = useCallback((id: string) => {
    setConceptRouteMode('deep')
    setSelConceptState(id)
  }, [])
  const [queries, setQueries] = useState<Partial<Record<ViewId, string>>>({})
  const query = queries[view] ?? ''
  const setQuery = useCallback((value: string) => setQueries((current) => ({ ...current, [view]: value })), [view])
  const [chatOpen, setChatOpen] = useState(false)
  const [chatBusy, setChatBusy] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(initialMessages)

  // Load the cascade in two stages so the app is usable immediately.
  //
  // Stage 1 (the graph) only needs the source topology, which the engine
  // answers from its background index in milliseconds — that unblocks the
  // shell. Stage 2 (resolve-all) fills in concepts and conflicts as they
  // arrive. While the engine is still reading sources it says so, and we poll
  // rather than making the user stare at a blocked screen: that full-page
  // "Resolving the cascade…" wait was the hang people hit on first run.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    const MAX_POLL_FAILURES = 3

    const pass = async (first: boolean) => {
      try {
        const g = await source.graph()
        if (cancelled) return
        setSources(adaptSources(g))
        setIndexingSources(g.indexingSources ?? [])
        setError(null)
        shellReadyRef.current = true
        setLoading(false) // the shell can render now — everything else streams in

        const [{ concepts: raw, errors, indexing, indexingSources: resolvingSources }, resolutionHistory] = await Promise.all([
          source.resolveAll(),
          source.conflictResolutions(),
        ])
        if (cancelled) return
        // Only fail the whole page when nothing resolved AND nothing is still
        // being read; a partial pass mid-index is expected, not an error.
        if (raw.length === 0 && errors.length > 0 && !indexing) {
          throw new LiveDataError('bad-shape', `No concept resolved (first error: ${errors[0].concept}: ${errors[0].error})`)
        }
        setLoadErrors(errors)
        // The graph and resolve-all requests are separate snapshots. Indexing
        // can finish between them; use the later answer so a stale graph never
        // leaves the banner running after polling has stopped.
        setIndexingSources(indexing ? (resolvingSources ?? g.indexingSources ?? []) : [])
        setConcepts(raw.map(adaptConcept))
        const derivedConflicts = adaptConflicts(raw, resolutionHistory)
        setConflicts(derivedConflicts)
        // Honor a deep-linked concept from the URL hash; else default to the
        // first. Only claim the deep link once it actually resolved.
        const pendingId = pendingConceptRef.current
        if (pendingId && raw.some((c) => c.id === pendingId)) {
          setView('concepts')
          setConceptRouteMode('deep')
          setSelConcept(pendingId)
          pendingConceptRef.current = undefined
        } else if (!indexing) {
          setSelConceptState((prev) => prev || raw[0]?.id || '')
          pendingConceptRef.current = undefined
        }
        setSelConflict((prev) => prev || derivedConflicts[0]?.id || '')
        setConceptsLoading(Boolean(indexing))
        failures = 0
        if (indexing) timer = setTimeout(() => void pass(false), 900)
      } catch (e) {
        if (cancelled) return
        // A failure on a background refresh must not blow away a working page.
        if (first && !shellReadyRef.current) {
          setError(e instanceof LiveDataError ? e : new LiveDataError('bad-shape', e instanceof Error ? e.message : String(e)))
          setLoading(false)
          setConceptsLoading(false)
          return
        }
        // Retry a stumble mid-index with backoff. Giving up silently here would
        // leave the "Indexing…" banner running forever with nothing refreshing
        // it, which reads as a hang — the exact impression to avoid.
        failures += 1
        if (failures <= MAX_POLL_FAILURES) {
          timer = setTimeout(() => void pass(false), 900 * failures)
          return
        }
        setConceptsLoading(false)
        setIndexingSources([]) // stop claiming work is still in flight
      }
    }

    // A refresh must not replace an already-usable shell with a full-page
    // loader. Besides the visual regression, doing so unmounts the Files editor
    // and can discard an unsaved draft. Only the initial bootstrap owns the
    // shell-level loading state.
    if (!shellReadyRef.current) setLoading(true)
    setConceptsLoading(true)
    setError(null)
    void pass(true)
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [source, reloadKey])

  // Refs so callbacks read the freshest values without re-subscribing.
  const queryRef = useRef(query); queryRef.current = query
  const triageTabRef = useRef(triageTab); triageTabRef.current = triageTab
  const signalsRef = useRef(signals); signalsRef.current = signals
  const selSignalRef = useRef(selSignal); selSignalRef.current = selSignal
  const selConflictRef = useRef(selConflict); selConflictRef.current = selConflict
  const selConceptRef = useRef(selConcept); selConceptRef.current = selConcept
  const chatBusyRef = useRef(chatBusy); chatBusyRef.current = chatBusy
  const chatInputRef = useRef(chatInput); chatInputRef.current = chatInput
  const conceptsRef = useRef(concepts); conceptsRef.current = concepts
  const conflictsRef = useRef(conflicts); conflictsRef.current = conflicts
  const resolvingConflictRef = useRef<string | null>(null)
  const modeRef = useRef(mode); modeRef.current = mode
  const pendingConceptRef = useRef<string | undefined>(initial.concept)
  const prevViewRef = useRef<ViewId>(view)

  const setView = useCallback((next: ViewId) => {
    if (next === view) return
    if (!dispatchNavigationGuard()) return
    if (next === 'concepts') setConceptRouteMode('bare')
    setViewState(next)
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

  // URL hash ⇄ state: reflect view/selected-concept for deep links, restore on
  // load (above), and support back/forward. pushState on view change (a real
  // navigation), replaceState within a view (selection tweak) to avoid spam.
  useEffect(() => {
    // While a deep-linked concept is still pending (loading, or load failed),
    // leave the URL alone — rewriting it here would permanently clobber the
    // deep link before the data arrives to honor it.
    if (pendingConceptRef.current) return
    const target = view === 'concepts' && selConcept && conceptRouteMode === 'deep'
      ? `#/concepts/${encodeURIComponent(selConcept)}`
      : `#/${view}`
    if (window.location.hash === target) { prevViewRef.current = view; return }
    const viewChanged = prevViewRef.current !== view
    prevViewRef.current = view
    if (viewChanged) window.history.pushState(null, '', target)
    else window.history.replaceState(null, '', target)
  }, [conceptRouteMode, view, selConcept])

  useEffect(() => {
    const onPop = () => {
      const p = parseHash(window.location.hash)
      if (p.view && p.view !== view) {
        if (!dispatchNavigationGuard()) {
          const current = view === 'concepts' && selConceptRef.current
            ? `#/concepts/${encodeURIComponent(selConceptRef.current)}` : `#/${view}`
          window.history.replaceState(null, '', current)
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
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [view])

  const filtered = useCallback((tab: TriageTab): Signal[] => {
    const route = TAB_TO_ROUTE[tab]
    const q = queryRef.current.trim().toLowerCase()
    return signalsRef.current.filter(
      (s) => s.route === route && (!q || `${s.title} ${s.repo} ${s.owner}`.toLowerCase().includes(q)),
    )
  }, [])

  const route = useCallback((target: RouteId) => {
    if (modeRef.current !== 'demo') return // live triage is read-only (D6)
    const sig = signalsRef.current.find((s) => s.id === selSignalRef.current)
    if (!sig) return

    const currentTab = triageTabRef.current
    const currentRoute = TAB_TO_ROUTE[currentTab]
    const q = queryRef.current.trim().toLowerCase()
    const matches = (s: Signal) => !q || `${s.title} ${s.repo} ${s.owner}`.toLowerCase().includes(q)
    const before = signalsRef.current.filter((s) => s.route === currentRoute && matches(s))
    const pos = before.findIndex((s) => s.id === sig.id)

    const nextSignals = signalsRef.current.map((s) => (s.id === sig.id ? { ...s, route: target } : s))
    signalsRef.current = nextSignals
    setSignals(nextSignals)

    const after = nextSignals.filter((s) => s.route === currentRoute && matches(s))
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
    }

    const complete = window.claude?.complete
    if (complete) {
      const prompt = `You are ContextCake, an assistant that answers ONLY from a team's resolved knowledge cascade (Company/Team/Personal layers; higher layers override per section). Answer the question in 1-3 sentences, plainly. If layers disagree, say which layer wins.\n\nCASCADE:\n${buildContext(conceptsRef.current)}\n\nQUESTION: ${q}`
      complete(prompt)
        .then((ans) => {
          setChatMessages((prev) => [...prev, { role: 'assistant', text: (ans || '').trim() }])
          setChatBusy(false)
        })
        .catch(finishCanned)
    } else {
      setTimeout(finishCanned, 620)
    }
  }, [])

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])
  const openChat = useCallback(() => setChatOpen(true), [])
  const closeChat = useCallback(() => setChatOpen(false), [])

  const load = useMemo<LoadState>(
    () => ({ shell: loading, concepts: conceptsLoading, indexingSources }),
    [loading, conceptsLoading, indexingSources],
  )

  const value = useMemo<Store>(() => ({
    mode, loading, load, error,
    view, triageTab, selSignal, selConflict, selConcept, query,
    chatOpen, chatBusy, chatInput, chatMessages,
    concepts, sources, signals, conflicts, activity, loadErrors, resolvingConflict, resolutionError,
    setView, setTriageTab, setSelSignal, setSelConflict, setSelConcept, setQuery,
    openChat, closeChat, setChatInput,
    filtered, route, resolveConflict, resolveSafeConflicts, send, reload,
  }), [mode, loading, load, error, view, triageTab, selSignal, selConflict, selConcept, query, chatOpen, chatBusy, chatInput, chatMessages, concepts, sources, signals, conflicts, activity, loadErrors, resolvingConflict, resolutionError, filtered, route, resolveConflict, resolveSafeConflicts, send, reload, setView, setQuery, openChat, closeChat])

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): Store {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}
