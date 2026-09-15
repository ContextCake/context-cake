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
export function retrievalSummary(rows: Observation[], operation: string) {
  const selected = rows.filter((r) => r.operation === operation)
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

function DiagnosticsInner() {
  const { mode } = useStoreData()
  const { mode: theme, density, setDensity } = useThemeMode()
  const bridge =
    mode === 'live' ? window.__CC_DESKTOP?.observability : undefined
  const [report, setReport] = useState<Report | null>(null)
  const [stack, setStack] = useState<StackStatus>({
    enabled: false,
    state: 'disabled',
  })
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
  if (mode !== 'live')
    return (
      <section className="cc-diagnostics">
        <EmptyState title="Your engine, in view">
          Native diagnostics and optional Local Grafana are available in the Mac
          app. This Web Demo never connects to your computer or starts a stack.
        </EmptyState>
      </section>
    )

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
            stack.state === 'ready'
              ? 'success'
              : stack.state === 'failed'
                ? 'attention'
                : 'neutral'
          }
        >
          {words(stack.state)}
        </StatusBadge>
      </div>
      <p>
        {stackCopy[stack.state] ??
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
      {stack.enabled && (
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
          <p>Source health, retrieval, and indexing on this Mac.</p>
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
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {tab === 'grafana' ? (
        <>
          <div className="cc-diag-toolbar">
            <span className="cc-diag-scope">Local Grafana · Experimental</span>
            <div className="cc-diag-actions">
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
          ) : (
            <div className="cc-diag-grafana-setup">{stackControls}</div>
          )}
          <p className="cc-diag-note">
            Includes participating desktop and MCP processes, distinguished by
            role. Other clients are not observed.
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
                {paused
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
            <Button
              variant="quiet"
              aria-pressed={paused}
              onClick={() => setPaused((p) => !p)}
            >
              {paused ? 'Resume updates' : 'Pause updates'}
            </Button>
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
                      ? `${report.sampleCount} ${report.sampleCount === 1 ? 'observation' : 'observations'}`
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
                      {['search', 'read'].map((operation) => {
                        const s = retrievalSummary(
                          report?.operations ?? [],
                          operation,
                        )
                        return (
                          <tr key={operation}>
                            <th scope="row">
                              {operation === 'search'
                                ? 'Search'
                                : 'Read context'}
                            </th>
                            <td className="is-number">{s.samples || '—'}</td>
                            <td className="is-number">{duration(s.median)}</td>
                            <td className="is-number">{duration(s.p95)}</td>
                            <td className="is-number">
                              {s.samples ? s.errors : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="cc-diag-footnote">
                  P95 needs 20 observations per operation. A dash means
                  insufficient data.
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
            Native observations cover this desktop engine only. Grafana combines
            participating processes. Updates every 5 seconds while this view is
            visible.
          </footer>
        </>
      )}
    </section>
  )
}
export const Diagnostics = memo(DiagnosticsInner)
