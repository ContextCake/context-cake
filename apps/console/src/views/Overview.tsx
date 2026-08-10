import { memo } from 'react'
import { progressLabel, progressPercent } from '../api'
import { layerName, layers } from '../data'
import { useStoreData } from '../store'
import { LayerChip } from '../components/LayerChip'
import { EmptyState, StatusBadge, Button } from '../components/ui'
import { AgentIcon } from '../components/icons'

function OverviewInner({ onConnectAgent }: { onConnectAgent?: () => void }) {
  const { mode, setView, signals, conflicts, sources, concepts, activity, loadErrors } = useStoreData()
  const queue = signals.filter((signal) => signal.route === 'review_required')
  const openConflicts = conflicts.filter((conflict) => ['needs_review', 'reopened', 'recommended', 'auto_ready', 'blocked'].includes(conflict.discrepancyStatus ?? (conflict.status === 'open' ? 'needs_review' : 'resolved')))
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
    { label: 'Discrepancies', value: openConflicts.length, view: 'conflicts' as const },
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
        {metrics.map((metric) => <button key={metric.label} type="button" onClick={() => setView(metric.view)}><strong>{metric.value}</strong><span>{metric.label}</span></button>)}
      </nav>

      <section className="cc-workspace-section" aria-labelledby="cc-cascade-summary">
        <div className="cc-section-heading"><div><h2 id="cc-cascade-summary">Cascade summary</h2><p>Higher layers win only for the sections they define; everything else is inherited.</p></div><button type="button" onClick={() => setView('canvas')}>Open Cascade</button></div>
        <div className="cc-cascade-summary">{[...layers].sort((a, b) => b.level - a.level).map((layer) => {
          const count = concepts.filter((concept) => concept.layers.includes(layer.id)).length
          // Real levels and source names behind this lane (F3), not the static
          // trio: a level-1 source that ranks into 'team' should say so here
          // too, not just on the Canvas. Demo mode's sources are already the
          // canonical company/team/personal trio, so this falls back to the
          // static blurb there unchanged.
          const rows = mode === 'demo' ? [] : sources.filter((source) => source.layer === layer.id)
          const levels = [...new Set(rows.map((row) => row.level).filter((level): level is number => typeof level === 'number'))].sort((a, b) => a - b)
          const levelLabel = levels.length ? levels.join('/') : String(layer.level)
          const sourceLabel = rows.length ? rows.map((row) => row.name).join(', ') : layer.sub
          return <div key={layer.id}><span className="cc-cascade-level">{levelLabel}</span><LayerChip id={layer.id} /><span>{sourceLabel}</span><strong>{count} concept{count === 1 ? '' : 's'}</strong></div>
        })}</div>
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
