import { memo } from 'react'
import { progressLabel, progressPercent } from '../api'
import { computeCascadeOrder, rankLabel, winsOverHint } from '../cascade-order'
import { layerName } from '../data'
import { useStoreData } from '../store'
import { LayerChip } from '../components/LayerChip'
import { EmptyState, StatusBadge, Button } from '../components/ui'
import { AgentIcon } from '../components/icons'
import { actionableByKind, isActionable, summarizeConflicts } from '../discrepancy-summary'

/** "12 broken links · 3 sections · 1 value" — the kinds behind the actionable count, largest first, zeros dropped. */
function kindSubtitle(byKind: Record<string, number>): string {
  const parts: [string, string, number][] = [
    ['broken link', 'broken links', byKind.broken_link ?? 0],
    ['section', 'sections', byKind.section_content ?? 0],
    ['value', 'values', byKind.frontmatter_value ?? 0],
    ['changed', 'changed', byKind.changed_after_decision ?? 0],
  ]
  return parts.filter(([, , count]) => count > 0).sort((a, b) => b[2] - a[2])
    .map(([one, many, count]) => `${count} ${count === 1 ? one : many}`).join(' · ')
}

function OverviewInner({ onConnectAgent }: { onConnectAgent?: () => void }) {
  const { mode, setView, signals, conflicts, conflictSummary, sources, concepts, activity, loadErrors } = useStoreData()
  // The real cascade, in the order it resolves: position 1 wins. Both modes
  // read the sources the store holds — the demo bundle's trio is a real
  // cascade too, not a static blurb to fall back to. A quarantined entry is
  // not in the cascade (nothing was built for it), so it gets no position;
  // Needs Attention and Source health still show it.
  const cascade = computeCascadeOrder(sources.filter((source) => !source.quarantined))
  const queue = signals.filter((signal) => signal.route === 'review_required')
  const openConflicts = conflicts.filter(isActionable)
  // The engine's summary when the store has one; the local mirror otherwise
  // (demo bundle, an engine without the compact route, or a test store).
  const summary = conflictSummary ?? summarizeConflicts(conflicts)
  const failedSources = sources.filter((source) => source.status === 'error' || source.status === 'degraded')
  const attention = [
    ...(queue.length ? [{ key: 'queue', label: `${queue.length} item${queue.length === 1 ? '' : 's'} waiting in Queue`, detail: 'Review captured knowledge before it is stored.', view: 'triage' as const, tone: 'attention' as const }] : []),
    ...(openConflicts.length ? [{ key: 'conflicts', label: `${openConflicts.length} actionable discrepanc${openConflicts.length === 1 ? 'y' : 'ies'}`, detail: 'Compare evidence and record a governed decision.', view: 'conflicts' as const, tone: 'attention' as const }] : []),
    ...failedSources.map((source) => ({ key: `source-${source.name}`, label: `${source.name} is ${source.status}`, detail: source.error || 'Open Sources for status and recovery actions.', view: 'sources' as const, tone: 'attention' as const })),
    ...(loadErrors.length ? [{ key: 'resolution', label: `${loadErrors.length} partial resolution failure${loadErrors.length === 1 ? '' : 's'}`, detail: 'The rest of the cascade remains available.', view: 'concepts' as const, tone: 'attention' as const }] : []),
  ]
  const metrics = [
    { label: 'Sources', value: sources.length, view: 'sources' as const },
    { label: 'Concepts', value: concepts.length, view: 'concepts' as const },
    // The subtitle counts actionable rows per kind (the summary's byKind counts decided rows too).
    { label: 'Discrepancies', value: summary.actionable, view: 'conflicts' as const, detail: kindSubtitle(actionableByKind(conflicts)) },
    { label: 'Queue', value: queue.length, view: 'triage' as const },
  ]

  return (
    <div className="cc-home">
      {onConnectAgent && (
        <section className="cc-workspace-section cc-connect-cta" aria-labelledby="cc-connect-agent">
          <div className="cc-section-heading">
            <div>
              <h2 id="cc-connect-agent">Connect an AI agent</h2>
              <p>Give Claude, Copilot, Cursor, or any other MCP-aware tool one governed view of this cascade — pick your tool and we'll walk you through it.</p>
            </div>
            <AgentIcon size={20} />
          </div>
          <Button type="button" variant="primary" onClick={onConnectAgent}>Connect an agent</Button>
        </section>
      )}

      <section className="cc-workspace-section" aria-labelledby="cc-needs-attention">
        <div className="cc-section-heading"><div><h2 id="cc-needs-attention">Needs Attention</h2><p>Work that may need a decision or recovery.</p></div>{attention.length > 0 && <StatusBadge tone="attention">{attention.length}</StatusBadge>}</div>
        {attention.length === 0 ? <EmptyState title="Nothing needs review">Your cascade is resolving cleanly.</EmptyState> : (
          <div className="cc-attention-list">{attention.map((item) => <button key={item.key} type="button" onClick={() => setView(item.view)}><span><strong>{item.label}</strong><small>{item.detail}</small></span><span aria-hidden="true">›</span></button>)}</div>
        )}
      </section>

      <nav className="cc-metric-strip" aria-label="Workspace totals">
        {metrics.map((metric) => <button key={metric.label} type="button" onClick={() => setView(metric.view)}><strong>{metric.value}</strong><span>{metric.label}</span>{'detail' in metric && metric.detail ? <small className="cc-metric-detail">{metric.detail}</small> : null}</button>)}
      </nav>

      <section className="cc-workspace-section" aria-labelledby="cc-cascade-order">
        <div className="cc-section-heading"><div><h2 id="cc-cascade-order">Cascade order</h2><p>Position 1 wins wherever it speaks; everything else is inherited from the layers below.</p></div><button type="button" onClick={() => setView('sources')}>{mode === 'live' ? 'Reorder in Sources' : 'Open Sources'}</button></div>
        {cascade.length === 0 ? <EmptyState title={sources.length ? 'No working sources' : 'No sources yet'}>{sources.length ? 'Every entry in the manifest is invalid — open Sources to remove them.' : 'Add a folder, repository, or MCP server to begin.'}</EmptyState> : (
          <ol className="cc-cascade-order" aria-label="Cascade order">{cascade.map((entry) => {
            // The engine's own count for this source, not a lane tally: two
            // sources sharing a lane are two rows here, each with its own number.
            const count = entry.conceptCount
            return (
              <li key={entry.name}>
                <span className="cc-cascade-rank" aria-label={`Position ${entry.rank}${entry.tied ? ', tied' : ''}`}>{rankLabel(entry)}</span>
                <LayerChip id={entry.layer} />
                <span><strong>{entry.name}</strong><small>{entry.sourceKind} · {winsOverHint(entry, cascade)}</small></span>
                <span>{count} concept{count === 1 ? '' : 's'}</span>
              </li>
            )
          })}</ol>
        )}
      </section>

      <section className="cc-workspace-section" aria-labelledby="cc-source-health">
        <div className="cc-section-heading"><div><h2 id="cc-source-health">Source health</h2><p>Current engine status for every layer feeding the cascade.</p></div><button type="button" onClick={() => setView('sources')}>Manage Sources</button></div>
        {sources.length === 0 ? <EmptyState title="No sources yet">Add a folder, repository, or MCP server to begin.</EmptyState> : <div className="cc-health-list">{sources.map((source) => <button key={source.name} type="button" onClick={() => setView('sources')}><span className={`cc-health-indicator cc-health-indicator--${source.status}`} aria-hidden="true" /><strong>{source.name}</strong><span>{layerName(source.layer)} · {source.status === 'indexing' ? progressLabel(source.indexing) : `${source.conceptCount} concept${source.conceptCount === 1 ? '' : 's'}`}{source.status !== 'indexing' && source.indexing?.refreshing ? ' · refreshing' : ''}</span><StatusBadge tone={source.status === 'serving' || source.status === 'synced' ? 'success' : source.status === 'error' || source.status === 'degraded' ? 'attention' : source.status === 'indexing' ? 'info' : 'neutral'}>{source.status === 'indexing' ? `indexing${progressPercent(source.indexing) == null ? '' : ` ${progressPercent(source.indexing)}%`}` : source.status}</StatusBadge></button>)}</div>}
      </section>

      {mode === 'demo' && activity.length > 0 && <section className="cc-workspace-section" aria-labelledby="cc-recent-activity"><div className="cc-section-heading"><div><h2 id="cc-recent-activity">Recent activity</h2><p>Illustrative demo events.</p></div></div><div className="cc-activity-list">{activity.map((item, index) => <div key={`${item.time}-${index}`}><LayerChip id={item.layer} /><span>{item.pre}<strong>{item.strong}</strong>{item.post}</span><time>{item.time}</time></div>)}</div></section>}
    </div>
  )
}

/**
 * Memoized. The shell re-renders for its own reasons — a drawer, a dialog, a
 * background-activity tick — and this view has no business repainting for any
 * of them. It re-renders when the store slices it subscribes to change, and
 * otherwise not at all.
 */
export const Overview = memo(OverviewInner)
