import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react'
import {
  activity as demoActivity, initialSignals, layerName,
  type Activity, type Concept, type Conflict, type Signal, type Source,
} from './data'
import {
  adaptConcept, adaptConflicts, adaptSources, createDataSource, LiveDataError, type Mode,
} from './api'
import type { GraphSummary } from './types'
import type { LayerId, RouteId } from './theme'

export type ViewId = 'canvas' | 'overview' | 'triage' | 'conflicts' | 'concepts'
export type TriageTab = 'review' | 'captured' | 'ignored'

const VIEW_IDS: ViewId[] = ['canvas', 'overview', 'triage', 'conflicts', 'concepts']

/** Parse the URL hash into a view + optional concept id (deep link). */
function parseHash(): { view?: ViewId; concept?: string } {
  if (typeof window === 'undefined') return {}
  const h = window.location.hash.replace(/^#\/?/, '')
  if (!h) return {}
  const slash = h.indexOf('/')
  const view = (slash === -1 ? h : h.slice(0, slash)) as ViewId
  const rest = slash === -1 ? '' : h.slice(slash + 1)
  if (!VIEW_IDS.includes(view)) return {}
  if (view === 'concepts' && rest) return { view, concept: decodeURIComponent(rest) }
  return { view }
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
      .map((s) => `${s.name} = "${s.value}" [${s.winner}]` + (s.dissent ? ` (conflicts with ${s.dissent.layer}: "${s.dissent.value}")` : ''))
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

export interface Store {
  mode: Mode
  loading: boolean
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

  graph: GraphSummary | null
  concepts: Concept[]
  sources: Source[]
  signals: Signal[]
  conflicts: Conflict[]
  activity: Activity[]

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
  /** Resolve a conflict — demo mode only (live mode is read-only, D6). */
  resolveConflict: (mode: 'accept' | 'promote' | 'override' | 'annotate') => void
  send: (text?: string) => void
  reload: () => void
}

const StoreContext = createContext<Store | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const source = useMemo(() => createDataSource(), [])
  const mode = source.mode

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<LiveDataError | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const [graph, setGraph] = useState<GraphSummary | null>(null)
  const [concepts, setConcepts] = useState<Concept[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  // Triage signals and the activity feed have no resolver equivalent — demo-only
  // fixtures (D6: live-mode triage is read-only, and there is no signal API).
  const [signals, setSignals] = useState<Signal[]>(mode === 'demo' ? initialSignals : [])
  const activity = mode === 'demo' ? demoActivity : []

  const [view, setView] = useState<ViewId>(() => parseHash().view ?? 'canvas')
  const [triageTab, setTriageTab] = useState<TriageTab>('review')
  const [selSignal, setSelSignal] = useState<string | null>(mode === 'demo' ? 'sig-1' : null)
  const [selConflict, setSelConflict] = useState('')
  const [selConcept, setSelConcept] = useState('')
  const [query, setQuery] = useState('')
  const [chatOpen, setChatOpen] = useState(false)
  const [chatBusy, setChatBusy] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(initialMessages)

  // Load the cascade from the data source (demo bundle or live playground API).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setError(null)
      try {
        const g = await source.graph()
        const ids = g.concepts.map((c) => c.id)
        const raw = await Promise.all(ids.map((id) => source.resolve(id)))
        if (cancelled) return
        setGraph(g)
        setSources(adaptSources(g))
        setConcepts(raw.map(adaptConcept))
        const derivedConflicts = adaptConflicts(raw)
        setConflicts(derivedConflicts)
        // Honor a deep-linked concept from the URL hash; else default to the first.
        const pending = pendingConceptRef.current
        if (pending && raw.some((c) => c.id === pending)) {
          setView('concepts')
          setSelConcept(pending)
        } else {
          setSelConcept((prev) => prev || raw[0]?.id || '')
        }
        pendingConceptRef.current = undefined
        setSelConflict((prev) => prev || derivedConflicts[0]?.id || '')
      } catch (e) {
        if (cancelled) return
        setError(e instanceof LiveDataError ? e : new LiveDataError('bad-shape', e instanceof Error ? e.message : String(e)))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [source, reloadKey])

  // Refs so callbacks read the freshest values without re-subscribing.
  const queryRef = useRef(query); queryRef.current = query
  const triageTabRef = useRef(triageTab); triageTabRef.current = triageTab
  const signalsRef = useRef(signals); signalsRef.current = signals
  const selSignalRef = useRef(selSignal); selSignalRef.current = selSignal
  const selConflictRef = useRef(selConflict); selConflictRef.current = selConflict
  const chatBusyRef = useRef(chatBusy); chatBusyRef.current = chatBusy
  const chatInputRef = useRef(chatInput); chatInputRef.current = chatInput
  const conceptsRef = useRef(concepts); conceptsRef.current = concepts
  const modeRef = useRef(mode); modeRef.current = mode
  const pendingConceptRef = useRef<string | undefined>(parseHash().concept)
  const prevViewRef = useRef<ViewId>(view)

  // URL hash ⇄ state: reflect view/selected-concept for deep links, restore on
  // load (above), and support back/forward. pushState on view change (a real
  // navigation), replaceState within a view (selection tweak) to avoid spam.
  useEffect(() => {
    const target = view === 'concepts' && selConcept
      ? `#/concepts/${encodeURIComponent(selConcept)}`
      : `#/${view}`
    if (window.location.hash === target) { prevViewRef.current = view; return }
    const viewChanged = prevViewRef.current !== view
    prevViewRef.current = view
    if (viewChanged) window.history.pushState(null, '', target)
    else window.history.replaceState(null, '', target)
  }, [view, selConcept])

  useEffect(() => {
    const onPop = () => {
      const p = parseHash()
      if (p.view) setView(p.view)
      if (p.concept) setSelConcept(p.concept)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

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

  const resolveConflict = useCallback((action: 'accept' | 'promote' | 'override' | 'annotate') => {
    if (modeRef.current !== 'demo') return // live mode is read-only (D6)
    setConflicts((prev) => prev.map((c) => {
      if (c.id !== selConflictRef.current) return c
      const win = layerName(c.winner)
      const others = c.contributions.filter((k) => k.layer !== c.winner).map((k) => layerName(k.layer)).join(' & ')
      let resolutionText: string
      if (action === 'accept') resolutionText = `${win} value confirmed as effective; ${others} retained as provenance.`
      else if (action === 'promote') resolutionText = `${others} value promoted over ${win}; the cascade now serves it.`
      else if (action === 'override') resolutionText = 'Personal override written — visible only to you until promoted to Team.'
      else resolutionText = 'Both values annotated; the tension is documented for the next reader.'
      return { ...c, status: 'resolved', resolutionText }
    }))
  }, [])

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

  const value = useMemo<Store>(() => ({
    mode, loading, error,
    view, triageTab, selSignal, selConflict, selConcept, query,
    chatOpen, chatBusy, chatInput, chatMessages,
    graph, concepts, sources, signals, conflicts, activity,
    setView, setTriageTab, setSelSignal, setSelConflict, setSelConcept, setQuery,
    openChat: () => setChatOpen(true), closeChat: () => setChatOpen(false), setChatInput,
    filtered, route, resolveConflict, send, reload,
  }), [mode, loading, error, view, triageTab, selSignal, selConflict, selConcept, query, chatOpen, chatBusy, chatInput, chatMessages, graph, concepts, sources, signals, conflicts, activity, filtered, route, resolveConflict, send, reload])

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): Store {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}
