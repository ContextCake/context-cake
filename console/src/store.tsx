import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  concepts, initialConflicts, initialSignals, layerName, sources,
  type Conflict, type Signal,
} from './data'
import type { LayerId, RouteId } from './theme'

export type ViewId = 'canvas' | 'overview' | 'triage' | 'conflicts' | 'concepts'
export type TriageTab = 'review' | 'captured' | 'ignored'

export interface Cite { layer: LayerId; label: string }
export interface ChatMessage {
  role: 'assistant' | 'user'
  text: string
  intro?: boolean
  cites?: Cite[]
  note?: string
}

const initialMessages: ChatMessage[] = [
  { role: 'assistant', intro: true, text: "Ask me anything about your team's knowledge. I read the resolved cascade — Company, Team, and your Personal layer — and tell you which layer each answer comes from." },
  { role: 'user', text: 'What database do we use?' },
  {
    role: 'assistant', text: 'Your team runs SingleStore for the primary database — chosen for its HTAP workloads.',
    cites: [{ layer: 'team', label: 'Team · systems/primary-db' }],
    note: 'This overrides the Company default (Postgres) for the Engine section only. Backups still inherit from Company.',
  },
]

declare global {
  interface Window {
    claude?: { complete?: (prompt: string) => Promise<string> }
  }
}

const TAB_TO_ROUTE: Record<TriageTab, RouteId> = {
  review: 'review_required', captured: 'team_candidate', ignored: 'ignore',
}

function buildContext(): string {
  return concepts
    .map((c) => `${c.id}: ` + c.sections
      .map((s) => `${s.name} = "${s.value}" [${s.winner}]` + (s.dissent ? ` (conflicts with ${s.dissent.layer}: "${s.dissent.value}")` : ''))
      .join('; '))
    .join('\n')
}

function cannedAnswer(q: string): { text: string; cites: Cite[]; note?: string } {
  const s = q.toLowerCase()
  if (/(jwt|audience|auth|token)/.test(s)) return { text: 'For internal service-to-service calls, the JWT audience is "internal.acme.com".', cites: [{ layer: 'team', label: 'Team · interfaces/jwt-audience-contract' }], note: 'The Company contract still says "api.acme.com" for external clients — this is an open conflict on the Audience section.' }
  if (/(on.?call|escalat|page|incident)/.test(s)) return { text: 'Your personal note says to ping @dana first — she owns billing. Company policy is to page the platform on-call, then the EM.', cites: [{ layer: 'personal', label: 'Personal · runbooks/oncall-escalation' }], note: 'Personal override wins for you; the team still sees the Company path.' }
  if (/(flag|feature)/.test(s)) return { text: 'Feature flags resolve server-side in the edge middleware, not on the client. Unknown flags default to off.', cites: [{ layer: 'team', label: 'Team · systems/web-app/feature-flags' }] }
  if (/(database|db|postgres|store)/.test(s)) return { text: 'Your team runs SingleStore for the primary database — chosen for HTAP workloads.', cites: [{ layer: 'team', label: 'Team · systems/primary-db' }], note: 'Overrides the Company default (Postgres) for the Engine section only.' }
  return { text: 'I resolved that across all three layers but found nothing specific. Try asking about the database, JWT audience, feature flags, or on-call escalation.', cites: [] }
}

export interface Store {
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
  signals: Signal[]
  conflicts: Conflict[]

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
  resolveConflict: (mode: 'accept' | 'promote' | 'override' | 'annotate') => void
  send: (text?: string) => void
}

const StoreContext = createContext<Store | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<ViewId>('canvas')
  const [triageTab, setTriageTab] = useState<TriageTab>('review')
  const [selSignal, setSelSignal] = useState<string | null>('sig-1')
  const [selConflict, setSelConflict] = useState('c1')
  const [selConcept, setSelConcept] = useState('systems/primary-db')
  const [query, setQuery] = useState('')
  const [chatOpen, setChatOpen] = useState(false)
  const [chatBusy, setChatBusy] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(initialMessages)
  const [signals, setSignals] = useState<Signal[]>(initialSignals)
  const [conflicts, setConflicts] = useState<Conflict[]>(initialConflicts)

  // Refs so callbacks read the freshest values without re-subscribing.
  const queryRef = useRef(query); queryRef.current = query
  const triageTabRef = useRef(triageTab); triageTabRef.current = triageTab
  const signalsRef = useRef(signals); signalsRef.current = signals
  const selSignalRef = useRef(selSignal); selSignalRef.current = selSignal
  const selConflictRef = useRef(selConflict); selConflictRef.current = selConflict
  const chatBusyRef = useRef(chatBusy); chatBusyRef.current = chatBusy
  const chatInputRef = useRef(chatInput); chatInputRef.current = chatInput

  const filtered = useCallback((tab: TriageTab): Signal[] => {
    const route = TAB_TO_ROUTE[tab]
    const q = queryRef.current.trim().toLowerCase()
    return signalsRef.current.filter(
      (s) => s.route === route && (!q || `${s.title} ${s.repo} ${s.owner}`.toLowerCase().includes(q)),
    )
  }, [])

  const route = useCallback((target: RouteId) => {
    const sig = signalsRef.current.find((s) => s.id === selSignalRef.current)
    if (!sig) return

    // Stay in the tab the user is triaging from — rapid S/R/D should march down
    // the current list, not follow the signal into its destination tab.
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
    // If the signal left this tab, `after[pos]` is the one that slid into its
    // slot; if it stayed (e.g. "keep in review"), step past it. Fall back to the
    // previous row, then to nothing when the tab is emptied.
    const stayed = target === currentRoute
    const next = stayed
      ? after[pos + 1] ?? after[pos] ?? null
      : after[pos] ?? after[after.length - 1] ?? null
    setSelSignal(next ? next.id : null)
  }, [])

  const resolveConflict = useCallback((mode: 'accept' | 'promote' | 'override' | 'annotate') => {
    setConflicts((prev) => prev.map((c) => {
      if (c.id !== selConflictRef.current) return c
      const win = layerName(c.winner)
      const others = c.contributions.filter((k) => k.layer !== c.winner).map((k) => layerName(k.layer)).join(' & ')
      let resolutionText: string
      if (mode === 'accept') resolutionText = `${win} value confirmed as effective; ${others} retained as provenance.`
      else if (mode === 'promote') resolutionText = `${others} value promoted over ${win}; the cascade now serves it.`
      else if (mode === 'override') resolutionText = 'Personal override written — visible only to you until promoted to Team.'
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
      setChatMessages((prev) => [...prev, { role: 'assistant', ...a }])
      setChatBusy(false)
    }

    const complete = window.claude?.complete
    if (complete) {
      const prompt = `You are ContextCake, an assistant that answers ONLY from a team's resolved knowledge cascade (Company/Team/Personal layers; higher layers override per section). Answer the question in 1-3 sentences, plainly. If layers disagree, say which layer wins.\n\nCASCADE:\n${buildContext()}\n\nQUESTION: ${q}`
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

  const value = useMemo<Store>(() => ({
    view, triageTab, selSignal, selConflict, selConcept, query,
    chatOpen, chatBusy, chatInput, chatMessages, signals, conflicts,
    setView, setTriageTab, setSelSignal, setSelConflict, setSelConcept, setQuery,
    openChat: () => setChatOpen(true), closeChat: () => setChatOpen(false), setChatInput,
    filtered, route, resolveConflict, send,
  }), [view, triageTab, selSignal, selConflict, selConcept, query, chatOpen, chatBusy, chatInput, chatMessages, signals, conflicts, filtered, route, resolveConflict, send])

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): Store {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}

export { sources }
