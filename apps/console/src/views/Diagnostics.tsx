import { memo, useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../api'
import type { SourceStatus } from '../types'
import { DiagnosticActivity } from './DiagnosticActivity'
import { useStoreData } from '../store'
import { useThemeMode } from '../theme-mode'
import {
  Button,
  EmptyState,
  InlineNotice,
  SegmentedControl,
  StatusBadge,
} from '../components/ui'

type StackStatus = {
  enabled: boolean
  historyGeneration?: number
  state: string
  origin?: string | null
  failure?: string | null
}
export type Observation = {
  at: number
  operation: string
  outcome: string
  durationMs: number
  traceId?: string
  resultCount?: number
  documentsRead?: number
  documentsReused?: number
  queueMs?: number
  phase?: 'cold' | 'warm'
  backend?: 'sqlite' | 'memory'
  candidateCount?: number
  storeSyncMs?: number
  decodedRecords?: number
}
type RetrievalIndexStats = {
  documents: number
  terms: number
  postings: number
  segments: number
  storeBytes: number | null
}
type RetrievalLastSearch = {
  at: number
  phase: 'cold' | 'warm'
  durationMs: number
  // null on the in-memory search backend, which has no per-search
  // analyzed/reused counter (see service.mjs's searchApi) — never guess it.
  documentsRead: number | null
  documentsReused: number | null
  candidateCount: number
  storeSyncMs: number
}
type RetrievalStats = {
  backend: 'sqlite' | 'memory'
  persisted: boolean
  index: RetrievalIndexStats | null
  lastSearch: RetrievalLastSearch | null
  searches: {
    cold: number
    warm: number
    medianWarmMs: number | null
    medianColdMs: number | null
  }
}
type Report = {
  observedFrom: number
  observedTo: number
  sampleCount: number
  operations: Observation[]
  telemetry?: {
    state: string
    historyGeneration?: number
    dropped: number
    sent: number
    queued: number
    exportedTraceIds?: string[]
  } | null
  health: {
    memory: string
    memoryDetail?: { liveBytes: number; totalBytes: number }
    sources: Array<
      SourceStatus & { warnings: number; evidenceHealthy?: boolean }
    >
  }
  indexing: { events: Array<{ at: number; line: string }> }
  retrieval?: RetrievalStats
}
const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
const duration = (n: number | null) =>
  n === null
    ? '—'
    : n < 1
      ? '<1 ms'
      : n >= 1000
        ? `${(n / 1000).toFixed(2)} s`
        : `${n.toFixed(1)} ms`
const words = (s: string) => s.replace(/[-_]/g, ' ')
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'unknown'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}
function relativeTime(at: number, now = Date.now()): string {
  const deltaMs = now - at
  if (deltaMs < 1000) return 'just now'
  const seconds = Math.round(deltaMs / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return clock(at)
}
function scrollDiagnostics(id?: string) {
  const view = document.querySelector('.cc-diagnostics')
  const scroller = view?.closest('.cc-main')
  if (!scroller) return
  const target = id ? document.getElementById(id) : null
  scroller.scrollTo?.({
    top: target
      ? scroller.scrollTop +
        target.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        20
      : 0,
  })
}
export function retrievalSummary(
  rows: Observation[],
  operation: string,
  phase?: 'cold' | 'warm',
) {
  const operationRows = rows.filter((r) => r.operation === operation)
  // An older engine never sends `phase` on any row — treat everything as
  // warm so the panel renders as it always has. A current engine omits
  // `phase` only on a row it recorded before it knew the phase: a search
  // that errored before analysis ran (diagnostics.mjs's measure() catch
  // path never calls annotate). That row is neither cold nor warm — it
  // never got an answer — so it must not inflate the warm median with a
  // failure-path duration. Only fall back to "no phase means warm" when
  // NOTHING in this operation ever reports a phase.
  const engineReportsPhase = operationRows.some((r) => r.phase !== undefined)
  const selected = operationRows.filter((r) => {
    if (phase === undefined) return true
    if (!engineReportsPhase) return phase === 'warm'
    return r.phase === phase
  })
  const durations = selected.map((r) => r.durationMs).sort((a, b) => a - b)
  return {
    samples: selected.length,
    errors: selected.filter((r) => r.outcome === 'error').length,
    median: durations.length
      ? (durations[Math.floor((durations.length - 1) / 2)] +
          durations[Math.floor(durations.length / 2)]) /
        2
      : null,
    p95:
      durations.length >= 20
        ? durations[Math.ceil(durations.length * 0.95) - 1]
        : null,
  }
}
export function grafanaUrl(
  origin: string | null | undefined,
  theme: string,
  range: string,
  trace?: string,
): string | null {
  if (!origin) return null
  if (
    !['light', 'dark'].includes(theme) ||
    !['now-15m', 'now-1h', 'now-24h'].includes(range)
  )
    return null
  try {
    const base = new URL(origin)
    if (
      base.protocol !== 'http:' ||
      base.hostname !== '127.0.0.1' ||
      !base.port ||
      base.username ||
      base.password ||
      base.pathname !== '/' ||
      base.search ||
      base.hash
    )
      return null
    if (trace && /^[a-f0-9]{32}$/.test(trace)) {
      return `${base.origin}/d/contextcake-trace/trace?kiosk&theme=${encodeURIComponent(theme)}&var-traceId=${encodeURIComponent(trace)}&from=${encodeURIComponent(range)}&to=now`
    }
    return `${base.origin}/d/contextcake/contextcake?kiosk&theme=${encodeURIComponent(theme)}&from=${encodeURIComponent(range)}&to=now&refresh=5s`
  } catch {
    return null
  }
}
const stackCopy: Record<string, string> = {
  disabled: 'Optional dashboards and traces, stored on this Mac.',
  stopped:
    'Your local history is preserved. Start Grafana to resume collection.',
  'docker-stopped':
    'Open Docker, wait for it to finish starting, then start Grafana.',
  downloading: 'Downloading the pinned telemetry image. You can keep working.',
  starting:
    'Starting the local backends. Retrieval continues while they warm up.',
  ready:
    'Receiving telemetry from this desktop engine and participating MCP clients.',
  failed:
    'The local stack needs attention. Your context engine continues to work.',
}

function createDemoReport(now = Date.now()): Report {
  const observedFrom = now - 15 * 60 * 1000
  const searches: Observation[] = Array.from({ length: 24 }, (_, i) => {
    const cold = i === 3 || i === 11
    return {
      at: observedFrom + i * 36_000,
      operation: 'search',
      outcome: i === 17 ? 'error' : 'ok',
      durationMs: cold ? 118 + ((i * 13) % 40) : 7 + ((i * 11) % 31),
      resultCount: i === 17 ? 0 : 3 + (i % 6),
      traceId: (i + 1).toString(16).padStart(32, '0'),
      phase: cold ? 'cold' : 'warm',
      backend: 'sqlite',
      candidateCount: 34 + ((i * 7) % 90),
      storeSyncMs: cold ? 5 + (i % 3) : 0,
      documentsRead: cold ? 1 + (i % 2) : 0,
      documentsReused: cold ? 5 : 0,
      decodedRecords: 3 + (i % 6),
    }
  })
  const reads: Observation[] = Array.from({ length: 24 }, (_, i) => ({
    at: observedFrom + 18_000 + i * 36_000,
    operation: 'read',
    outcome: 'ok',
    durationMs: 3 + ((i * 7) % 18),
    traceId: (i + 101).toString(16).padStart(32, '0'),
  }))
  const operations: Observation[] = [
    ...searches,
    ...reads,
    {
      at: now - 82_000,
      operation: 'index',
      outcome: 'error',
      durationMs: 1_482,
      documentsRead: 1,
      documentsReused: 17,
      queueMs: 184,
      traceId: 'f'.repeat(32),
    },
    {
      at: now - 7 * 60_000,
      operation: 'coverage',
      outcome: 'partial',
      durationMs: 0,
      traceId: 'e'.repeat(32),
    },
  ].sort((a, b) => b.at - a.at)

  const warmSearches = retrievalSummary(operations, 'search', 'warm')
  const coldSearches = retrievalSummary(operations, 'search', 'cold')
  const lastSearchRow = operations.find((row) => row.operation === 'search')

  return {
    observedFrom,
    observedTo: now,
    sampleCount: operations.length,
    operations,
    retrieval: {
      backend: 'sqlite',
      persisted: true,
      index: {
        documents: 2483,
        terms: 9318,
        postings: 41760,
        segments: 4,
        storeBytes: 6_291_456,
      },
      lastSearch: lastSearchRow
        ? {
            at: lastSearchRow.at,
            phase: lastSearchRow.phase ?? 'warm',
            durationMs: lastSearchRow.durationMs,
            documentsRead: lastSearchRow.documentsRead ?? 0,
            documentsReused: lastSearchRow.documentsReused ?? 0,
            candidateCount: lastSearchRow.candidateCount ?? 0,
            storeSyncMs: lastSearchRow.storeSyncMs ?? 0,
          }
        : null,
      searches: {
        warm: warmSearches.samples,
        cold: coldSearches.samples,
        medianWarmMs: warmSearches.median,
        medianColdMs: coldSearches.median,
      },
    },
    telemetry: {
      state: 'ready',
      historyGeneration: 0,
      dropped: 0,
      sent: operations.length,
      queued: 0,
      exportedTraceIds: operations.flatMap((row) =>
        row.traceId ? [row.traceId] : [],
      ),
    },
    health: {
      memory: 'normal',
      memoryDetail: { liveBytes: 86 * 1048576, totalBytes: 16 * 1073741824 },
      sources: [
        {
          name: 'personal',
          level: 3,
          kind: 'okf-local',
          status: 'ok',
          phase: 'ready',
          loaded: 7,
          total: 7,
          conceptCount: 7,
          refreshing: false,
          error: null,
          warnings: 0,
          evidenceHealthy: true,
        },
        {
          name: 'team',
          level: 2,
          kind: 'okf-local',
          status: 'degraded',
          phase: 'error',
          loaded: 18,
          total: 18,
          conceptCount: 18,
          refreshing: false,
          error: 'Latest refresh incomplete; serving the previous index.',
          warnings: 1,
          evidenceHealthy: false,
        },
        {
          name: 'company',
          level: 0,
          kind: 'okf-local',
          status: 'ok',
          phase: 'ready',
          loaded: 31,
          total: 31,
          conceptCount: 31,
          refreshing: false,
          error: null,
          warnings: 0,
          evidenceHealthy: true,
        },
      ],
    },
    indexing: {
      events: [
        {
          at: now - 82_000,
          line: 'Team refresh completed with partial source coverage.',
        },
        {
          at: now - 94_000,
          line: 'Read 1 changed document and reused 17 indexed documents.',
        },
      ],
    },
  }
}

function DemoGrafanaPreview({ report }: { report: Report }) {
  const searches = retrievalSummary(report.operations, 'search')
  const reads = retrievalSummary(report.operations, 'read')
  const retrievals = searches.samples + reads.samples
  const failures = searches.errors + reads.errors
  const observedSeconds = Math.max(
    1,
    (report.observedTo - report.observedFrom) / 1000,
  )
  const failureRate = failures / observedSeconds
  const index = report.operations.find((row) => row.operation === 'index')
  const incompleteSources = report.health.sources.filter(
    (source) =>
      !['ready', 'ok'].includes(source.status) ||
      source.warnings > 0 ||
      source.evidenceHealthy === false,
  ).length
  return (
    <section
      className="cc-diag-grafana-preview"
      aria-label="Sample Local Grafana dashboard"
    >
      <header>
        <div>
          <span className="cc-diag-scope">Sample dashboard summary</span>
          <h3>ContextCake operations</h3>
        </div>
        <StatusBadge tone="info">Illustration</StatusBadge>
      </header>
      <div className="cc-diag-grafana-grid">
        <section>
          <span>Retrieval volume</span>
          <strong>{retrievals}</strong>
          <small>Search and read operations</small>
        </section>
        <section>
          <span>Retrieval duration p95</span>
          <strong>{duration(searches.p95)}</strong>
          <small>Search · {duration(reads.p95)} read</small>
        </section>
        <section className={failures ? 'has-errors' : ''}>
          <span>Failures per second</span>
          <strong>{failureRate.toFixed(3)}</strong>
          <small>{failures} in this sample window</small>
        </section>
        <section>
          <span>Latest index duration</span>
          <strong>{duration(index?.durationMs ?? null)}</strong>
          <small>Most recent sample pass</small>
        </section>
        <section className={incompleteSources ? 'has-errors' : ''}>
          <span>Incomplete sources</span>
          <strong>{incompleteSources}</strong>
          <small>Current source coverage</small>
        </section>
        <section>
          <span>Documents read and reused · process totals</span>
          <strong>
            {index?.documentsRead ?? '—'} / {index?.documentsReused ?? '—'}
          </strong>
          <small>Sample desktop process</small>
        </section>
        <section>
          <span>Latest index queue wait</span>
          <strong>{duration(index?.queueMs ?? null)}</strong>
          <small>Before the sample pass started</small>
        </section>
        <section>
          <span>Telemetry delivery failures</span>
          <strong>{report.telemetry?.dropped ?? '—'}</strong>
          <small>Best-effort local export</small>
        </section>
      </div>
      <div className="cc-diag-grafana-events">
        <header className="cc-diag-section-heading">
          <h3>Correlated events and traces</h3>
          <span className="cc-diag-note">Desktop · sample</span>
        </header>
        <div className="cc-diag-table">
          <table>
            <caption className="sr-only">
              Sample correlated events and traces
            </caption>
            <thead>
              <tr>
                <th>Operation</th>
                <th>Outcome</th>
                <th className="is-number">Duration</th>
                <th>Process role</th>
              </tr>
            </thead>
            <tbody>
              {report.operations.slice(0, 4).map((row, index) => (
                <tr key={`${row.operation}-${index}`}>
                  <th scope="row">{words(row.operation)}</th>
                  <td>{words(row.outcome)}</td>
                  <td className="is-number">{duration(row.durationMs)}</td>
                  <td>desktop</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <footer>
        The installed Mac app replaces this illustration with the provisioned
        Grafana dashboard and trace view. The Web Demo never creates a frame or
        connects to a local service.
      </footer>
    </section>
  )
}

function DiagnosticsInner() {
  const { mode } = useStoreData()
  const isDemo = mode !== 'live'
  const { mode: theme, density, setDensity } = useThemeMode()
  const bridge =
    mode === 'live' ? window.__CC_DESKTOP?.observability : undefined
  const [report, setReport] = useState<Report | null>(() =>
    isDemo ? createDemoReport() : null,
  )
  const [stack, setStack] = useState<StackStatus>(() =>
    isDemo
      ? { enabled: true, state: 'ready', historyGeneration: 0 }
      : { enabled: false, state: 'disabled' },
  )
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'overview' | 'grafana'>('overview')
  const [range, setRange] = useState('now-15m')
  const [trace, setTrace] = useState<string>()
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState('all')
  useEffect(() => {
    scrollDiagnostics()
  }, [tab])
  useEffect(() => {
    if (mode !== 'live' || paused) return
    let closed = false,
      timer: ReturnType<typeof setTimeout>
    let controller: AbortController | null = null
    const refresh = async () => {
      if (closed) return
      if (!document.hidden) {
        controller = new AbortController()
        try {
          const [response, status] = await Promise.all([
            apiFetch('/api/diagnostics', { signal: controller.signal }),
            bridge?.status(),
          ])
          if (!response.ok) throw new Error('Diagnostics unavailable')
          const data = (await response.json()) as Report
          if (!closed) {
            setReport(data)
            setError('')
            if (status) setStack(status)
          }
        } catch {
          if (!closed)
            setError(
              'Could not refresh diagnostics. Any values below are from the last successful observation.',
            )
        }
      }
      if (!closed) timer = setTimeout(() => void refresh(), 5000)
    }
    void refresh()
    return () => {
      closed = true
      clearTimeout(timer)
      controller?.abort()
    }
  }, [mode, bridge, paused])
  const act = async (action: keyof NonNullable<typeof bridge>) => {
    if (!bridge) return
    setBusy(true)
    try {
      setStack(
        await (action === 'open'
          ? bridge.open({ traceId: trace, range, theme })
          : bridge[action]()),
      )
      if (action === 'clear') setTrace(undefined)
      setError('')
    } catch {
      setError('The local Grafana action failed. Check Docker and retry.')
    } finally {
      setBusy(false)
    }
  }
  const rows = useMemo(
    () =>
      (report?.operations ?? []).filter(
        (o) =>
          filter === 'all' ||
          (filter === 'retrieval'
            ? ['search', 'read'].includes(o.operation)
            : filter === 'errors'
              ? ['error', 'cancelled', 'blocked', 'partial', 'stale'].includes(
                  o.outcome,
                )
              : o.operation === 'index'),
      ),
    [report, filter],
  )
  const frame =
    mode === 'live' && stack.state === 'ready'
      ? grafanaUrl(stack.origin, theme, range, trace)
      : null
  const transitioning = ['starting', 'downloading'].includes(stack.state)
  const sourceAttention =
    report?.health.sources.filter(
      (s) =>
        !['ready', 'ok'].includes(s.status) ||
        s.warnings > 0 ||
        s.evidenceHealthy === false,
    ).length ?? 0
  const searches = retrievalSummary(report?.operations ?? [], 'search')
  const reads = retrievalSummary(report?.operations ?? [], 'read')
  const retrievalCount = searches.samples + reads.samples
  const retrievalErrors = searches.errors + reads.errors
  const workingSources =
    report?.health.sources.filter(
      (s) =>
        s.refreshing || ['queued', 'scanning', 'loading'].includes(s.phase),
    ).length ?? 0

  const stackControls = (
    <section className="cc-diag-stack" aria-labelledby="local-grafana-title">
      <header>
        <h3 id="local-grafana-title">Local Grafana</h3>
        <StatusBadge>Experimental</StatusBadge>
      </header>
      <div className="cc-diag-stack-state">
        <StatusBadge
          tone={
            isDemo
              ? 'info'
              : stack.state === 'ready'
              ? 'success'
              : stack.state === 'failed'
                ? 'attention'
                : 'neutral'
          }
        >
          {isDemo ? 'Sample ready state' : words(stack.state)}
        </StatusBadge>
      </div>
      <p>
        {isDemo
          ? 'This preview represents the app-managed local stack after setup. The Web Demo does not start Docker or collect telemetry.'
          : stackCopy[stack.state] ??
            'Stack management requires a supported Mac app.'}
      </p>
      {stack.failure && (
        <p className="cc-diag-failure">Reference: {stack.failure}</p>
      )}
      {bridge && (
        <div className="cc-diag-actions">
          {!stack.enabled ? (
            <>
              <p>
                Setup downloads a Docker image and enables local telemetry.
                Docker must already be installed.
              </p>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void act('setup')}
              >
                Enable Local Grafana
              </Button>
            </>
          ) : (
            <>
              {stack.state === 'docker-stopped' && (
                <Button disabled={busy} onClick={() => void act('docker')}>
                  Start Docker
                </Button>
              )}
              {stack.state !== 'ready' && (
                <Button
                  variant="primary"
                  disabled={busy || transitioning}
                  onClick={() => void act('start')}
                >
                  {transitioning ? 'Starting…' : 'Start Grafana'}
                </Button>
              )}
              {(stack.state === 'ready' || transitioning) && (
                <Button disabled={busy} onClick={() => void act('stop')}>
                  Stop
                </Button>
              )}
              {stack.state === 'ready' && (
                <Button disabled={busy} onClick={() => void act('restart')}>
                  Restart
                </Button>
              )}
            </>
          )}
        </div>
      )}
      <dl className="cc-diag-facts">
        <div>
          <dt>Storage</dt>
          <dd>This Mac · 24 hours</dd>
        </div>
        <div>
          <dt>Starts with app</dt>
          <dd>When enabled and Docker is running</dd>
        </div>
      </dl>
      {stack.enabled && !isDemo && (
        <details className="cc-diag-management">
          <summary>Manage local history & setup</summary>
          <p>
            Normal restarts preserve telemetry. Restart existing MCP sessions
            after enabling telemetry.
          </p>
          <div className="cc-diag-actions">
            <Button disabled={busy} onClick={() => void act('disable')}>
              Disable
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => void act('clear')}
            >
              Clear local history…
            </Button>
          </div>
        </details>
      )}
    </section>
  )

  return (
    <section className="cc-diagnostics" aria-label="Engine diagnostics">
      <header className="cc-diag-heading">
        <div>
          <h2>Engine diagnostics</h2>
          <p>
            {isDemo
              ? 'A sample of source health, retrieval, and indexing in the Mac app.'
              : 'Source health, retrieval, and indexing on this Mac.'}
          </p>
        </div>
        <SegmentedControl
          label="Diagnostics view"
          value={tab}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'grafana', label: 'Grafana' },
          ]}
          onChange={setTab}
        />
      </header>
      {isDemo && (
        <InlineNotice>
          <strong>Sample data.</strong> This read-only preview mirrors the native
          diagnostics layout. It never connects to your computer, contacts
          localhost, starts Docker, or creates a Grafana frame.
        </InlineNotice>
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {tab === 'grafana' ? (
        <>
          <div className="cc-diag-toolbar">
            <span className="cc-diag-scope">
              {isDemo
                ? 'Local Grafana · sample data'
                : 'Local Grafana · Experimental'}
            </span>
            <div className="cc-diag-actions">
              {isDemo ? (
                <span className="cc-diag-note">Last 15 minutes · static preview</span>
              ) : (
                <label>
                  Time range{' '}
                  <select
                    value={range}
                    onChange={(e) => setRange(e.target.value)}
                  >
                    <option value="now-15m">Last 15 minutes</option>
                    <option value="now-1h">Last hour</option>
                    <option value="now-24h">Last 24 hours</option>
                  </select>
                </label>
              )}
              {trace && (
                <Button onClick={() => setTrace(undefined)}>
                  Back to dashboard
                </Button>
              )}
              {frame && (
                <Button onClick={() => void act('open')}>
                  Open in browser ↗
                </Button>
              )}
            </div>
          </div>
          {frame ? (
            <iframe
              className="cc-diag-frame"
              title={trace ? 'Grafana trace' : 'Local Grafana dashboard'}
              src={frame}
              sandbox="allow-scripts allow-same-origin"
              referrerPolicy="no-referrer"
            />
          ) : isDemo && report ? (
            <DemoGrafanaPreview report={report} />
          ) : (
            <div className="cc-diag-grafana-setup">{stackControls}</div>
          )}
          <p className="cc-diag-note">
            {isDemo
              ? 'The installed dashboard includes participating desktop and MCP processes, distinguished by role. Other clients are not observed.'
              : 'Includes participating desktop and MCP processes, distinguished by role. Other clients are not observed.'}
          </p>
        </>
      ) : (
        <>
          <div className="cc-diag-toolbar">
            <div className="cc-diag-observation">
              <span
                className={`cc-diag-dot${paused || error ? ' is-paused' : ''}`}
                aria-hidden="true"
              />
              <span>
                {isDemo
                  ? 'Sample desktop engine'
                  : paused
                  ? 'Observation paused'
                  : error
                    ? 'Refresh unavailable'
                    : 'Desktop engine'}
              </span>
              {report && (
                <span className="cc-diag-note">
                  {clock(report.observedFrom)}–{clock(report.observedTo)}
                </span>
              )}
            </div>
            {!isDemo && (
              <Button
                variant="quiet"
                aria-pressed={paused}
                onClick={() => setPaused((p) => !p)}
              >
                {paused ? 'Resume updates' : 'Pause updates'}
              </Button>
            )}
          </div>
          <div className="cc-diag-statusline">
            <div>
              <StatusBadge tone={sourceAttention ? 'attention' : 'neutral'}>
                {!report
                  ? 'Checking source health'
                  : !report.health.sources.length
                    ? 'No sources configured'
                    : sourceAttention
                      ? `${sourceAttention} ${sourceAttention === 1 ? 'source needs' : 'sources need'} attention`
                      : 'Sources available'}
              </StatusBadge>
              <span>
                {report
                  ? `${report.health.sources.length} configured · ${workingSources ? `${workingSources} indexing` : 'No index pass in progress'}`
                  : 'Waiting for the engine'}
              </span>
            </div>
            <Button
              variant="quiet"
              onClick={() => scrollDiagnostics('diagnostic-sources')}
            >
              Inspect sources ↓
            </Button>
          </div>
          <div className="cc-diag-metrics" aria-label="Retrieval summary">
            <div>
              <span>Observed retrievals</span>
              <strong>{report ? retrievalCount.toLocaleString() : '—'}</strong>
              <small>
                {report
                  ? `${searches.samples} ${searches.samples === 1 ? 'search' : 'searches'} · ${reads.samples} ${reads.samples === 1 ? 'read' : 'reads'}`
                  : 'Waiting for observations'}
              </small>
            </div>
            <div className={retrievalErrors ? 'has-errors' : ''}>
              <span>Failed retrievals</span>
              <strong>
                {retrievalCount ? retrievalErrors.toLocaleString() : '—'}
              </strong>
              <small>
                {retrievalCount
                  ? `${((retrievalErrors / retrievalCount) * 100).toFixed(1)}% of observed retrievals`
                  : 'No retrieval samples'}
              </small>
            </div>
            <div>
              <span>Search duration · median</span>
              <strong>{duration(searches.median)}</strong>
              <small>
                {searches.samples
                  ? `${searches.samples} measured ${searches.samples === 1 ? 'search' : 'searches'}`
                  : 'No search samples'}
              </small>
            </div>
            <div>
              <span>Read duration · median</span>
              <strong>{duration(reads.median)}</strong>
              <small>
                {reads.samples
                  ? `${reads.samples} measured ${reads.samples === 1 ? 'read' : 'reads'}`
                  : 'No read samples'}
              </small>
            </div>
          </div>
          <div className="cc-diag-layout">
            <div className="cc-diag-primary">
              <DiagnosticActivity
                rows={report?.operations ?? []}
                from={report?.observedFrom ?? 0}
                to={report?.observedTo ?? 0}
              />
              <section className="cc-diag-section cc-diag-panel cc-diag-latency">
                <header className="cc-diag-section-heading">
                  <h3>Retrieval performance</h3>
                  <span className="cc-diag-note">
                    {report
                      ? `${retrievalCount} ${retrievalCount === 1 ? 'retrieval observation' : 'retrieval observations'}`
                      : 'Waiting for the engine'}
                  </span>
                </header>
                <p className="cc-diag-note">
                  Measured search and read operations in the recent observation
                  window.
                </p>
                <div className="cc-diag-table">
                  <table>
                    <caption className="sr-only">
                      Retrieval duration and errors by operation
                    </caption>
                    <thead>
                      <tr>
                        <th>Operation</th>
                        <th className="is-number">Samples</th>
                        <th className="is-number">Median</th>
                        <th className="is-number">P95</th>
                        <th className="is-number">Errors</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { operation: 'search', label: 'Search' },
                        { operation: 'read', label: 'Read context' },
                      ].flatMap(({ operation, label }) => {
                        const warm = retrievalSummary(
                          report?.operations ?? [],
                          operation,
                          'warm',
                        )
                        const cold = retrievalSummary(
                          report?.operations ?? [],
                          operation,
                          'cold',
                        )
                        const rows = [
                          <tr key={operation}>
                            <th scope="row">{label}</th>
                            <td className="is-number">
                              {warm.samples || '—'}
                            </td>
                            <td className="is-number">
                              {duration(warm.median)}
                            </td>
                            <td className="is-number">
                              {duration(warm.p95)}
                            </td>
                            <td className="is-number">
                              {warm.samples ? warm.errors : '—'}
                            </td>
                          </tr>,
                        ]
                        if (cold.samples > 0) {
                          rows.push(
                            <tr
                              key={`${operation}-cold`}
                              className="cc-diag-row-cold"
                            >
                              <th scope="row">{label} · cold</th>
                              <td className="is-number">{cold.samples}</td>
                              <td className="is-number">
                                {duration(cold.median)}
                              </td>
                              <td className="is-number">
                                {duration(cold.p95)}
                              </td>
                              <td className="is-number">
                                {cold.errors || '—'}
                              </td>
                            </tr>,
                          )
                        }
                        return rows
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="cc-diag-footnote">
                  P95 needs 20 warm observations per operation. A dash means
                  insufficient data. Warm numbers are what to expect; a cold
                  search or read paid to index changed documents first.
                </p>
              </section>
              <section
                className="cc-diag-section cc-diag-sources-panel"
                id="diagnostic-sources"
              >
                <header className="cc-diag-section-heading">
                  <h3>Source health & indexing</h3>
                  {report && (
                    <StatusBadge
                      tone={sourceAttention ? 'attention' : 'neutral'}
                    >
                      {sourceAttention
                        ? `${sourceAttention} ${sourceAttention === 1 ? 'needs' : 'need'} attention`
                        : `${report.health.sources.length} sources`}
                    </StatusBadge>
                  )}
                </header>
                {report?.health.sources.length ? (
                  <div className="cc-diag-table cc-diag-source-table">
                    <table>
                      <caption className="sr-only">
                        Source health and indexing progress
                      </caption>
                      <thead>
                        <tr>
                          <th>Source</th>
                          <th>Coverage</th>
                          <th>Indexing</th>
                          <th className="is-number">Documents</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...report.health.sources]
                          .sort(
                            (a, b) =>
                              Number(
                                !['ok', 'ready'].includes(b.status) ||
                                  b.warnings > 0 ||
                                  b.evidenceHealthy === false,
                              ) -
                              Number(
                                !['ok', 'ready'].includes(a.status) ||
                                  a.warnings > 0 ||
                                  a.evidenceHealthy === false,
                              ),
                          )
                          .map((s) => (
                            <tr key={s.name}>
                              <th scope="row" title={s.name}>
                                {s.name}
                                {s.error && (
                                  <span
                                    className="cc-diag-source-error"
                                    title={s.error}
                                  >
                                    {s.error}
                                  </span>
                                )}
                              </th>
                              <td>
                                <StatusBadge
                                  tone={
                                    s.warnings ||
                                    s.evidenceHealthy === false ||
                                    ['error', 'degraded'].includes(s.status)
                                      ? 'attention'
                                      : 'neutral'
                                  }
                                >
                                  {s.status === 'ok'
                                    ? s.evidenceHealthy === false
                                      ? 'Needs attention'
                                      : 'Available'
                                    : words(s.status)}
                                </StatusBadge>
                                {s.warnings > 0 && (
                                  <span className="cc-diag-work">
                                    {s.warnings}{' '}
                                    {s.warnings === 1 ? 'warning' : 'warnings'}
                                  </span>
                                )}
                              </td>
                              <td>
                                {s.refreshing
                                  ? 'Refreshing'
                                  : s.phase === 'ready'
                                    ? 'Up to date'
                                    : words(s.phase)}
                              </td>
                              <td className="is-number">
                                {s.total == null
                                  ? 'Document total unknown'
                                  : `${s.loaded.toLocaleString()} / ${s.total.toLocaleString()}`}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState
                    title={
                      report
                        ? 'No sources configured'
                        : 'Checking source health'
                    }
                  >
                    {report
                      ? 'Add a source to begin indexing and retrieval.'
                      : 'The current engine status will appear here.'}
                  </EmptyState>
                )}
              </section>
              <section className="cc-diag-section cc-diag-operations-panel">
                <header className="cc-diag-section-heading">
                  <div>
                    <h3>Recent operations</h3>
                    <p className="cc-diag-note">
                      Inspect an operation, then follow its trace.
                    </p>
                  </div>
                  <div className="cc-diag-actions">
                    <label>
                      <span className="sr-only">Filter operations</span>
                      <select
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                      >
                        <option value="all">All operations</option>
                        <option value="retrieval">Retrieval</option>
                        <option value="index">Indexing</option>
                        <option value="errors">Needs attention</option>
                      </select>
                    </label>
                    <Button
                      variant="quiet"
                      aria-pressed={density === 'compact'}
                      onClick={() =>
                        setDensity(
                          density === 'compact' ? 'comfortable' : 'compact',
                        )
                      }
                    >
                      {density === 'compact'
                        ? 'Comfortable rows'
                        : 'Compact rows'}
                    </Button>
                  </div>
                </header>
                {rows.length ? (
                  <div className="cc-diag-table">
                    <table>
                      <caption className="sr-only">
                        Recent engine operations
                      </caption>
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Operation</th>
                          <th>Outcome</th>
                          <th className="is-number">Duration</th>
                          <th className="is-number">Candidates</th>
                          <th>Phase</th>
                          <th>
                            <span className="sr-only">Trace</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.slice(0, 30).map((o, i) => (
                          <tr key={`${o.traceId}-${i}`}>
                            <td className="cc-diag-time">{clock(o.at)}</td>
                            <th scope="row">
                              {words(o.operation)}
                              {o.operation === 'index' &&
                                o.documentsRead !== undefined && (
                                  <span className="cc-diag-work">
                                    {o.documentsRead} read ·{' '}
                                    {o.documentsReused ?? 0} reused
                                  </span>
                                )}
                              {o.operation === 'search' &&
                                o.resultCount !== undefined && (
                                  <span className="cc-diag-work">
                                    {o.resultCount}{' '}
                                    {o.resultCount === 1 ? 'result' : 'results'}
                                  </span>
                                )}
                            </th>
                            <td>
                              <StatusBadge
                                tone={
                                  ['error', 'blocked', 'partial'].includes(
                                    o.outcome,
                                  )
                                    ? 'attention'
                                    : 'neutral'
                                }
                              >
                                {words(o.outcome)}
                              </StatusBadge>
                            </td>
                            <td className="is-number">
                              {['search', 'read', 'index'].includes(o.operation)
                                ? duration(o.durationMs)
                                : '—'}
                            </td>
                            <td className="is-number">
                              {o.operation === 'search' &&
                              o.candidateCount !== undefined
                                ? o.candidateCount.toLocaleString()
                                : ''}
                            </td>
                            <td>
                              {o.operation === 'search' && o.phase
                                ? words(o.phase)
                                : ''}
                            </td>
                            <td className="cc-diag-trace">
                              {frame &&
                                o.traceId &&
                                report?.telemetry?.historyGeneration ===
                                  stack.historyGeneration &&
                                report?.telemetry?.exportedTraceIds?.includes(
                                  o.traceId,
                                ) && (
                                  <Button
                                    variant="quiet"
                                    aria-label={`View ${o.operation} trace at ${clock(o.at)}`}
                                    onClick={() => {
                                      setTrace(o.traceId)
                                      setTab('grafana')
                                    }}
                                  >
                                    Trace ↗
                                  </Button>
                                )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState
                    title={
                      filter === 'all'
                        ? 'No operations yet'
                        : 'No matching operations'
                    }
                  >
                    {filter === 'all'
                      ? 'Search your context to record the first retrieval.'
                      : 'Choose another filter or leave this view open as you work.'}
                  </EmptyState>
                )}
                <p className="cc-diag-footnote">
                  Showing {Math.min(rows.length, 30)} of {rows.length} matching
                  observations. The engine retains up to 200 events for 15
                  minutes.
                </p>
              </section>
            </div>
            <aside
              className="cc-diag-aside"
              aria-label="Engine and telemetry controls"
            >
              <section className="cc-diag-section">
                <header className="cc-diag-section-heading">
                  <h3>Engine resources</h3>
                </header>
                <dl className="cc-diag-facts">
                  <div>
                    <dt>Memory pressure</dt>
                    <dd>
                      {report ? words(report.health.memory) : 'Checking…'}
                    </dd>
                  </div>
                  {report?.health.memoryDetail && (
                    <div>
                      <dt>Engine memory</dt>
                      <dd>
                        {Math.round(
                          report.health.memoryDetail.liveBytes / 1048576,
                        ).toLocaleString()}{' '}
                        MB
                      </dd>
                    </div>
                  )}
                </dl>
                <p className="cc-diag-note">
                  Live heap and external memory. Indexing can pause under memory
                  pressure.
                </p>
              </section>
              {report?.retrieval && (
                <section className="cc-diag-section">
                  <header className="cc-diag-section-heading">
                    <h3>Retrieval index</h3>
                    <StatusBadge
                      tone={
                        report.retrieval.backend === 'sqlite' &&
                        report.retrieval.persisted
                          ? 'success'
                          : 'neutral'
                      }
                    >
                      {report.retrieval.backend === 'sqlite' &&
                      report.retrieval.persisted
                        ? 'On disk'
                        : 'In memory'}
                    </StatusBadge>
                  </header>
                  <dl className="cc-diag-facts">
                    <div>
                      <dt>Documents</dt>
                      <dd>
                        {report.retrieval.index
                          ? report.retrieval.index.documents.toLocaleString()
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt>Terms</dt>
                      <dd>
                        {report.retrieval.index
                          ? report.retrieval.index.terms.toLocaleString()
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt>Postings</dt>
                      <dd>
                        {report.retrieval.index
                          ? report.retrieval.index.postings.toLocaleString()
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt>Segments</dt>
                      <dd>
                        {report.retrieval.index
                          ? report.retrieval.index.segments.toLocaleString()
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt>On-disk size</dt>
                      <dd>
                        {report.retrieval.index
                          ? formatBytes(report.retrieval.index.storeBytes)
                          : '—'}
                      </dd>
                    </div>
                  </dl>
                  <p className="cc-diag-note">Last search</p>
                  <dl className="cc-diag-facts">
                    <div>
                      <dt>Phase</dt>
                      <dd>
                        {report.retrieval.lastSearch
                          ? words(report.retrieval.lastSearch.phase)
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt>Duration</dt>
                      <dd>
                        {report.retrieval.lastSearch
                          ? duration(report.retrieval.lastSearch.durationMs)
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt>Documents read / reused</dt>
                      <dd>
                        {report.retrieval.lastSearch
                          ? `${report.retrieval.lastSearch.documentsRead ?? '—'} / ${report.retrieval.lastSearch.documentsReused ?? '—'}`
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt>Candidates</dt>
                      <dd>
                        {report.retrieval.lastSearch
                          ? report.retrieval.lastSearch.candidateCount.toLocaleString()
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt>Sync time</dt>
                      <dd>
                        {report.retrieval.lastSearch
                          ? duration(report.retrieval.lastSearch.storeSyncMs)
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt>When</dt>
                      <dd>
                        {report.retrieval.lastSearch
                          ? relativeTime(report.retrieval.lastSearch.at)
                          : '—'}
                      </dd>
                    </div>
                  </dl>
                </section>
              )}
              {stackControls}
              {report?.telemetry && stack.enabled && (
                <section className="cc-diag-section">
                  <header className="cc-diag-section-heading">
                    <h3>Telemetry delivery</h3>
                  </header>
                  <dl className="cc-diag-facts">
                    <div>
                      <dt>State</dt>
                      <dd>{words(report.telemetry.state)}</dd>
                    </div>
                    <div>
                      <dt>Sent / queued</dt>
                      <dd>
                        {report.telemetry.sent.toLocaleString()} /{' '}
                        {report.telemetry.queued}
                      </dd>
                    </div>
                    <div>
                      <dt>Dropped</dt>
                      <dd>{report.telemetry.dropped.toLocaleString()}</dd>
                    </div>
                  </dl>
                  <p className="cc-diag-note">
                    Delivery is best effort. A backend outage never pauses
                    retrieval.
                  </p>
                </section>
              )}
              {!!report?.indexing.events.length && (
                <details className="cc-diag-management">
                  <summary>Recent indexing activity</summary>
                  <ol className="cc-diag-events">
                    {report.indexing.events
                      .slice(-8)
                      .reverse()
                      .map((e, i) => (
                        <li key={i}>
                          <time>{clock(e.at)}</time>
                          <span>{e.line}</span>
                        </li>
                      ))}
                  </ol>
                </details>
              )}
            </aside>
          </div>
          <footer className="cc-diag-footer">
            {isDemo
              ? 'Sample observations use the bundled three-layer demo. In the Mac app, native observations cover the desktop engine and Local Grafana combines participating processes.'
              : 'Native observations cover this desktop engine only. Grafana combines participating processes. Updates every 5 seconds while this view is visible.'}
          </footer>
        </>
      )}
    </section>
  )
}
export const Diagnostics = memo(DiagnosticsInner)
