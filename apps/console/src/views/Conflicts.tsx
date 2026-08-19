// The Discrepancy Center. The pieces live in ./conflicts/: OverviewHeader
// (tiles, status tabs with counts, group-by, filters), GroupedList (the
// windowed grouped list with multi-select), BulkBar (act on the selection
// after a dry run), DecisionPanel + Evidence (one row's detail), Rules
// (governed learning). This file owns the state that ties them together —
// filters, grouping, collapse, selection, the open detail, the receipt.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Conflict } from '../data'
import { useStoreData, useStoreInput, useStoreNav } from '../store'
import { useDetailSurface } from '../components/useDetailSurface'
import { actionableByKind, buildHaystack, groupConflicts, summarizeConflicts, type GroupBy } from '../discrepancy-summary'
import { OverviewHeader } from './conflicts/OverviewHeader'
import { GroupedList } from './conflicts/GroupedList'
import { BulkBar, type BulkOutcome } from './conflicts/BulkBar'
import { DecisionPanel, type AppliedDecision } from './conflicts/DecisionPanel'
import { History, Skeleton, SourceAnswer } from './conflicts/Evidence'
import { Rules } from './conflicts/Rules'
import { DEFAULT_FILTERS, matchesFilters, tabFor, type ConflictFilters } from './conflicts/filters'
import { KIND_LABEL, STATUS_LABEL, plural } from './conflicts/labels'

/** Groups start closed once there are more than this many — three open groups still fit a screen. */
const OPEN_BY_DEFAULT_MAX = 3

function ConflictsInner() {
  const { mode, conflicts, conflictSummary, setSelConflict, setQuery, loadDiscrepancyDetail, approveRuleSuggestion } = useStoreData()
  const { selConflict } = useStoreNav()
  const { query } = useStoreInput()
  const [filters, setFilters] = useState<ConflictFilters>(DEFAULT_FILTERS)
  const [groupBy, setGroupBy] = useState<GroupBy>('kind')
  // Explicit opens/closes only; anything not here follows the default rule.
  const [collapseOverrides, setCollapseOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set())
  const [detailOpen, setDetailOpen] = useState(Boolean(selConflict))
  const [notice, setNotice] = useState<AppliedDecision | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const detail = useDetailSurface<HTMLDivElement, HTMLElement>(detailOpen)

  // The store always carries a summary; a partial store (tests) may not, and
  // the local mirror is exactly what the store would have computed for it.
  const summary = useMemo(() => conflictSummary ?? summarizeConflicts(conflicts), [conflictSummary, conflicts])
  const owners = useMemo(() => [...new Set(conflicts.map((item) => item.owner ?? 'Unassigned'))].sort(), [conflicts])
  const sources = useMemo(() => [...new Set(conflicts.flatMap((item) => item.contributions.map((entry) => entry.sourceLayer)))].sort(), [conflicts])
  const actionableKinds = useMemo(() => actionableByKind(conflicts), [conflicts])
  // One lowercase haystack per row, rebuilt only when the list changes — the
  // old predicate re-stringified every contribution per row per keystroke.
  const haystacks = useMemo(() => new Map(conflicts.map((item) => [item.id, buildHaystack(item)])), [conflicts])
  const normalizedQuery = (query ?? '').trim().toLowerCase()
  const visible = useMemo(() => conflicts.filter((item) => matchesFilters(item, filters)
    && (!normalizedQuery || (haystacks.get(item.id) ?? '').includes(normalizedQuery))), [conflicts, filters, normalizedQuery, haystacks])
  const groups = useMemo(() => groupConflicts(visible, groupBy), [visible, groupBy])
  const collapsedByDefault = groups.length > OPEN_BY_DEFAULT_MAX
  const isCollapsed = useCallback((key: string) => collapseOverrides.get(key) ?? collapsedByDefault, [collapseOverrides, collapsedByDefault])
  const onToggleGroup = useCallback((key: string, collapsed: boolean) => {
    setCollapseOverrides((prev) => { const next = new Map(prev); next.set(key, collapsed); return next })
  }, [])
  const onGroupBy = useCallback((next: GroupBy) => { setGroupBy(next); setCollapseOverrides(new Map()) }, [])

  // The open detail: the store's selection when it is on screen, else the
  // first visible row — the same fallback the list used before grouping.
  const selected = useMemo(() => visible.find((item) => item.id === selConflict) ?? visible[0] ?? null, [visible, selConflict])
  // A compact row on screen fetches its full record (the store does this for
  // the selected id; this covers the visible[0] fallback too).
  useEffect(() => {
    if (selected && selected.detailLoaded === false) void loadDiscrepancyDetail(selected.id)
  }, [selected, loadDiscrepancyDetail])

  // Selection ⊆ visible: a filter or a refetch that hides a row also drops
  // it from the selection, so a bulk action never reaches something the
  // user cannot see.
  useEffect(() => {
    setSelection((prev) => {
      if (prev.size === 0) return prev
      const keep = new Set(visible.filter((item) => prev.has(item.id)).map((item) => item.id))
      return keep.size === prev.size ? prev : keep
    })
  }, [visible])
  const selectedItems = useMemo(() => visible.filter((item) => selection.has(item.id)), [visible, selection])
  const clearSelection = useCallback(() => setSelection(new Set()), [])
  const onSelectionChange = useCallback((next: Set<string>) => setSelection(next), [])

  const restoreListFocus = () => requestAnimationFrame(() => {
    const target = listRef.current?.querySelector<HTMLElement>('[role="option"][aria-current="true"]')
      ?? listRef.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]')
    target?.focus({ preventScroll: true })
  })

  const onDecisionApplied = (applied: AppliedDecision) => {
    setNotice(applied)
    setDetailOpen(false)
    restoreListFocus()
  }

  const onBulkOutcome = ({ label, response }: BulkOutcome) => {
    const failedIds = response.results.filter((result) => !result.ok).map((result) => result.discrepancyId)
    // Failures stay selected — that is the retry set; successes leave it.
    setSelection(new Set(failedIds))
    const suggestion = response.suggestions?.[0]
    setNotice({
      kind: 'batch',
      applied: response.applied,
      failed: response.failed,
      failedIds,
      message: `${label}: ${response.applied} done${response.failed ? ` · ${response.failed} need attention` : ''}.${response.git?.queued ? ' The team push is queued until the remote is reachable.' : ''}`,
      ...(suggestion ? {
        suggestionId: suggestion.id,
        suggestionLabel: suggestion.action.type === 'rewrite_link' ? `Rewrite → ${suggestion.action.newTarget}` : suggestion.action.type === 'prefer_source' ? `Prefer ${suggestion.action.source}` : `Acknowledge as ${suggestion.action.reasonCode.replace(/_/g, ' ')}`,
      } : {}),
    })
  }

  const openRow = useCallback((id: string) => { setSelConflict(id); setDetailOpen(true) }, [setSelConflict])

  useEffect(() => {
    const close = () => { setDetailOpen(false); restoreListFocus() }
    window.addEventListener('contextcake:close-detail', close)
    return () => window.removeEventListener('contextcake:close-detail', close)
  }, [])

  const emptyState = normalizedQuery
    ? <div className="cc-conflict-empty"><strong>No matches for &quot;{query.trim()}&quot; in this status.</strong><p>The search keeps filtering across status tabs until cleared.</p><button type="button" onClick={() => setQuery('')}>Clear search</button></div>
    : <div className="cc-conflict-empty"><strong>No discrepancies in this view</strong><p>Adjust the filters or return to Needs review.</p>{filters !== DEFAULT_FILTERS && <button type="button" onClick={() => setFilters(DEFAULT_FILTERS)}>Reset filters</button>}</div>

  return (
    <div className="cc-conflicts cc-discrepancy-center">
      <header className="cc-discrepancy-header"><div><span className="cc-eyebrow">Alignment workspace</span><h2>Discrepancy Center</h2><p>{plural(summary.actionable, 'actionable item')}. Structural evidence only—no model-inferred contradictions.</p></div><span className="cc-actionable-count">{summary.actionable}</span></header>
      <section className="cc-discrepancy-guide" aria-label="How to resolve a discrepancy">
        <strong>Resolve differences one at a time, or many at once</strong>
        <ol>
          <li><span>1</span>Review the evidence</li>
          <li><span>2</span>Choose the safest next step</li>
          <li><span>3</span>Confirm what changes</li>
        </ol>
      </section>
      {conflicts.some((item) => item.coverageComplete === false) && <div className="cc-coverage-warning" role="status">Coverage is incomplete while sources index or recover. Broken-link findings are paused.</div>}
      <OverviewHeader
        summary={summary}
        actionableKinds={actionableKinds}
        filters={filters}
        onFilters={setFilters}
        groupBy={groupBy}
        onGroupBy={onGroupBy}
        owners={owners}
        sources={sources}
      />
      <div ref={detail.containerRef} className="cc-conflict-layout cc-navigator-detail">
        <div ref={listRef} className="cc-conflict-column">
          {selectedItems.length > 0 && <BulkBar items={selectedItems} onClear={clearSelection} onOutcome={onBulkOutcome} />}
          <GroupedList
            groups={groups}
            isCollapsed={isCollapsed}
            onToggleGroup={onToggleGroup}
            currentId={selected?.id ?? null}
            onOpen={openRow}
            selection={selection}
            onSelectionChange={onSelectionChange}
            emptyState={emptyState}
            label="Discrepancies"
          />
        </div>
        {selected && <Detail conflict={selected} panelRef={detail.panelRef} panelProps={detail.panelProps} open={detailOpen} onClose={() => { setDetailOpen(false); restoreListFocus() }} onApplied={onDecisionApplied} mode={mode} />}
      </div>
      <Rules />
      {notice && (
        <div className="cc-decision-receipt" role="status" aria-live="polite" aria-atomic="true">
          <span><strong>Done.</strong> {notice.message}</span>
          <div>
            {notice.kind === 'single' && (
              <button type="button" onClick={() => {
                setFilters({ ...DEFAULT_FILTERS, status: tabFor(notice.status) })
                setSelConflict(notice.discrepancyId)
                setDetailOpen(true)
                setNotice(null)
              }}>View in {STATUS_LABEL[notice.status]}</button>
            )}
            {notice.kind === 'batch' && notice.suggestionId && mode !== 'demo' && (
              <button type="button" onClick={() => { void approveRuleSuggestion(notice.suggestionId as string); setNotice(null) }}>Create rule: {notice.suggestionLabel}</button>
            )}
            <button type="button" aria-label="Dismiss confirmation" onClick={() => setNotice(null)}>Dismiss</button>
          </div>
        </div>
      )}
    </div>
  )
}

function Detail({ conflict, panelRef, panelProps, open, onClose, onApplied, mode }: {
  conflict: Conflict
  panelRef: React.RefObject<HTMLElement | null>
  panelProps: ReturnType<typeof useDetailSurface<HTMLDivElement, HTMLElement>>['panelProps']
  open: boolean
  onClose: () => void
  onApplied: (applied: AppliedDecision) => void
  mode: string
}) {
  const decided = ['resolved', 'acknowledged'].includes(conflict.discrepancyStatus ?? '')
  const loading = conflict.detailLoaded === false
  const effectiveValue = conflict.contributions.find((item) => item.sourceLayer === conflict.effectiveSource)?.value ?? conflict.contributions[0]?.value ?? ''
  return (
    <section ref={panelRef} {...panelProps} className="cc-conflict-detail cc-navigator-detail-panel" data-open={open || undefined} aria-label={`${conflict.title} discrepancy detail`}>
      <button type="button" className="cc-detail-close" onClick={onClose}>Close</button>
      <div className="cc-discrepancy-path"><code>{conflict.concept}</code><span>{conflict.section}</span></div>
      <div className="cc-discrepancy-title">
        <div><span className="cc-kind-pill">{KIND_LABEL[conflict.kind ?? 'section_content']}</span><h2>Why this needs attention</h2></div>
        <span className="cc-status-large">{STATUS_LABEL[conflict.discrepancyStatus ?? 'needs_review']}</span>
      </div>
      <p className="cc-discrepancy-explanation">{conflict.kind === 'broken_link' ? `The effective content links to ${conflict.target}, but no settled source currently provides that concept.` : conflict.kind === 'frontmatter_value' ? `Multiple contributors author different values for “${conflict.section}”.` : conflict.kind === 'changed_after_decision' ? 'A contributor changed after the previous decision, so the discrepancy reopened automatically.' : `Multiple contributors give materially different answers for “${conflict.section}”.`}</p>
      {conflict.ruleConflict && <div className="cc-conflict-error" role="alert"><strong>Rule conflict.</strong> Matching rules disagree, so no automatic action will run.</div>}
      {conflict.matchingRules?.map((rule) => <div className="cc-rule-match" key={rule.id}>Matched {rule.scope} {rule.mode} rule <code>{rule.id}</code> from {rule.evidenceDecisionIds.length} decisions.</div>)}
      {conflict.kind === 'broken_link' ? (
        <>
          {!decided && <DecisionPanel conflict={conflict} onApplied={onApplied} />}
          <details className="cc-review-details">
            <summary>Review evidence and metadata</summary>
            <div className="cc-evidence-grid cc-broken-link-evidence-grid">
              <div><span>Linked from</span><strong>{conflict.effectiveSource ?? 'None'}</strong></div>
              <div><span>Owner</span><strong>{conflict.owner ?? 'Unassigned'}</strong></div>
              <div><span>Source health</span><strong>{conflict.sourceHealth?.every((item) => item?.status === 'ok') ? 'All healthy' : 'Needs attention'}</strong></div>
            </div>
            <section className="cc-link-evidence">
              <h3>Missing target</h3>
              <div><code>{conflict.target}</code><span>{conflict.winnerReason}</span></div>
            </section>
          </details>
        </>
      ) : (
        <>
          <div className="cc-evidence-grid">
            <div><span>Effective source</span><strong>{conflict.effectiveSource ?? 'None'}</strong></div>
            <div><span>Why it won</span><strong>{conflict.winnerReason}</strong></div>
            <div><span>Owner</span><strong>{conflict.owner ?? 'Unassigned'}</strong></div>
            <div><span>Source health</span><strong>{conflict.sourceHealth?.every((item) => item?.status === 'ok') ? 'All healthy' : 'Needs attention'}</strong></div>
          </div>
          <section>
            <h3>Compare every answer</h3>
            {loading
              ? <Skeleton lines={5} label="Loading every answer" />
              : <div className="cc-answer-stack">{conflict.contributions.map((choice) => <SourceAnswer key={choice.sourceLayer} choice={choice} effective={effectiveValue} isEffective={choice.sourceLayer === conflict.effectiveSource} />)}</div>}
          </section>
          {!decided && <DecisionPanel conflict={conflict} onApplied={onApplied} />}
        </>
      )}
      <section>
        <h3>Decision history</h3>
        {mode === 'demo' && <p className="cc-muted">Simulation history resets on reload.</p>}
        {loading
          ? (conflict.historyCount ? <Skeleton lines={2} label={`Loading ${plural(conflict.historyCount, 'decision')}`} /> : <p className="cc-muted">No previous decisions.</p>)
          : <History conflict={conflict} />}
      </section>
    </section>
  )
}

/**
 * Memoized. The shell re-renders for its own reasons — a drawer, a dialog, a
 * background-activity tick — and this view has no business repainting for any
 * of them. It re-renders when the store slices it subscribes to change, and
 * otherwise not at all.
 */
export const Conflicts = memo(ConflictsInner)
