// The top of the Discrepancy Center: what is open, by kind and by quick win,
// each a filter you can click; the status tabs with their counts; group-by.
// Numbers come from the engine's summary (or its local mirror) — the tiles
// never wait on the list.
import { SegmentedControl } from '../../components/ui'
import { DISCREPANCY_KINDS, type GroupBy } from '../../discrepancy-summary'
import type { DiscrepancyKind, DiscrepancySummary } from '../../types'
import { DEFAULT_FILTERS, STATUS_TABS, tabCount, type ConflictFilters } from './filters'
import { KIND_LABEL, plural } from './labels'

const KIND_TILE_LABEL: Record<DiscrepancyKind, [string, string]> = {
  section_content: ['section', 'sections'],
  frontmatter_value: ['value', 'values'],
  broken_link: ['broken link', 'broken links'],
  changed_after_decision: ['changed since decided', 'changed since decided'],
}

export const GROUP_OPTIONS: ReadonlyArray<{ value: GroupBy; label: string }> = [
  { value: 'kind', label: 'Kind' },
  { value: 'concept', label: 'Concept' },
  { value: 'sourcePair', label: 'Source pair' },
  { value: 'owner', label: 'Owner' },
]

export interface OverviewHeaderProps {
  summary: DiscrepancySummary
  /** Actionable rows per kind, from the loaded list (the summary's byKind counts decided rows too). */
  actionableKinds: Record<DiscrepancyKind, number>
  filters: ConflictFilters
  onFilters: (next: ConflictFilters) => void
  groupBy: GroupBy
  onGroupBy: (next: GroupBy) => void
  owners: string[]
  sources: string[]
}

export function OverviewHeader({ summary, actionableKinds, filters, onFilters, groupBy, onGroupBy, owners, sources }: OverviewHeaderProps) {
  const { quickWins } = summary
  const set = (patch: Partial<ConflictFilters>) => onFilters({ ...filters, ...patch })
  const kindActive = (kind: DiscrepancyKind) => filters.kind === kind && !filters.fixable && filters.status === 'actionable'
  const allActive = filters.kind === 'all' && !filters.fixable && filters.status === 'actionable'
  const fixableActive = filters.fixable && filters.kind === 'broken_link'

  return (
    <>
      <div className="cc-dc-tiles" role="group" aria-label="What needs attention">
        <button type="button" className="cc-dc-tile cc-dc-tile--total" aria-pressed={allActive} onClick={() => onFilters({ ...DEFAULT_FILTERS })}>
          <strong>{summary.actionable}</strong>
          <span>actionable</span>
          <small>{plural(summary.total, 'discrepancy', 'discrepancies')} in all</small>
        </button>
        {DISCREPANCY_KINDS.map((kind) => (
          <button key={kind} type="button" className="cc-dc-tile" aria-pressed={kindActive(kind)} onClick={() => set({ status: 'actionable', kind, fixable: false })} title={`Show actionable ${KIND_LABEL[kind].toLowerCase()} discrepancies`}>
            <strong>{actionableKinds[kind]}</strong>
            <span>{actionableKinds[kind] === 1 ? KIND_TILE_LABEL[kind][0] : KIND_TILE_LABEL[kind][1]}</span>
          </button>
        ))}
        <div className="cc-dc-quick" role="group" aria-label="Quick wins">
          <span className="cc-dc-quick-label">Quick wins</span>
          <button type="button" aria-pressed={filters.status === 'automated'} disabled={quickWins.autoReady === 0} onClick={() => set({ status: 'automated', kind: 'all', fixable: false })}>
            <strong>{quickWins.autoReady}</strong> ready to run automatically
          </button>
          <button type="button" aria-pressed={filters.status === 'recommended'} disabled={quickWins.recommended === 0} onClick={() => set({ status: 'recommended', kind: 'all', fixable: false })}>
            <strong>{quickWins.recommended}</strong> with a recommendation
          </button>
          <button type="button" aria-pressed={fixableActive} disabled={quickWins.brokenLinksWithBestCandidate === 0} onClick={() => set({ status: 'actionable', kind: 'broken_link', fixable: true })}>
            <strong>{quickWins.brokenLinksWithBestCandidate}</strong> of {quickWins.brokenLinksTotal} broken links have a suggested fix
          </button>
        </div>
      </div>
      <nav className="cc-status-tabs" aria-label="Discrepancy status">
        {STATUS_TABS.map((tab) => {
          const count = tabCount(summary, tab.value)
          return (
            <button key={tab.value} type="button" aria-pressed={filters.status === tab.value} data-active={filters.status === tab.value} onClick={() => set({ status: tab.value })}>
              {tab.label}<span className="cc-status-tab-count" aria-label={`${count} ${count === 1 ? 'item' : 'items'}`}>{count}</span>
            </button>
          )
        })}
      </nav>
      <div className="cc-discrepancy-filters" aria-label="Discrepancy filters">
        <SegmentedControl<GroupBy> label="Group by" value={groupBy} options={GROUP_OPTIONS} onChange={onGroupBy} />
        <select aria-label="Kind" value={filters.kind} onChange={(event) => set({ kind: event.target.value as ConflictFilters['kind'], fixable: false })}><option value="all">All kinds</option>{DISCREPANCY_KINDS.map((value) => <option key={value} value={value}>{KIND_LABEL[value]}</option>)}</select>
        <select aria-label="Owner" value={filters.owner} onChange={(event) => set({ owner: event.target.value })}><option value="all">All owners</option>{owners.map((value) => <option key={value}>{value}</option>)}</select>
        <select aria-label="Source" value={filters.source} onChange={(event) => set({ source: event.target.value })}><option value="all">All sources</option>{sources.map((value) => <option key={value}>{value}</option>)}</select>
        <select aria-label="Priority" value={filters.priority} onChange={(event) => set({ priority: event.target.value })}><option value="all">All priorities</option><option value="unassigned">Unassigned</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>
        <label className="cc-filter-check"><input type="checkbox" checked={filters.newerOnly} onChange={(event) => set({ newerOnly: event.target.checked })} /> Newer dissent</label>
        {filters.fixable && <label className="cc-filter-check"><input type="checkbox" checked onChange={() => set({ fixable: false })} /> Has a suggested fix</label>}
      </div>
    </>
  )
}
