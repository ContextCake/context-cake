import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Conflict, Contribution } from '../data'
import type { AcknowledgementReason, DiscrepancyStatus } from '../types'
import { Markdown } from '../components/Markdown'
import { useStoreData, useStoreInput, useStoreNav } from '../store'
import { useDetailSurface } from '../components/useDetailSurface'

const STATUS_LABEL: Record<DiscrepancyStatus, string> = {
  needs_review: 'Needs review', reopened: 'Needs review', recommended: 'Recommendations',
  auto_ready: 'Automated', acknowledged: 'Acknowledged', resolved: 'Resolved', blocked: 'Automated',
}
const KIND_LABEL: Record<string, string> = {
  section_content: 'Section content', frontmatter_value: 'Frontmatter value',
  broken_link: 'Broken link', changed_after_decision: 'Changed after decision',
}
const REASONS: { value: AcknowledgementReason; label: string }[] = [
  { value: 'different_scopes', label: 'Different scopes' },
  { value: 'temporary_migration', label: 'Temporary migration' },
  { value: 'source_specific_authority', label: 'Source-specific authority' },
  { value: 'other', label: 'Other' },
]
// Broken-link-only: acknowledging why a link target doesn't exist yet is a
// distinct reason from the general four above. The engine's allowedReasons
// set (service.mjs) already accepts this value — verified before adding it
// here, since the UI must never offer a reason the API would 400.
const TARGET_MISSING_REASON: { value: AcknowledgementReason; label: string } = { value: 'target_missing', label: 'Target not created yet' }

function formatDate(value?: string | null) {
  if (!value) return 'Date not recorded'
  const parsed = new Date(value.includes('T') ? value : `${value}T12:00:00`)
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: value.includes('T') ? 'short' : undefined }).format(parsed)
}

function valueKind(value: string) {
  return /```|^\s*[{[]|\n\s*[-+]?\s*["'][^\n]+:|\n.*[;{}]$/m.test(value) ? 'structured' : 'prose'
}

type DiffOperation = { type: 'same' | 'removed' | 'added'; value: string }

function sequenceDiff(left: string[], right: string[]): DiffOperation[] {
  // Bound quadratic work for unusually large answers. The fallback remains
  // honest and complete—it shows both originals as removed/added—without
  // letting a pathological document freeze the review surface.
  if (left.length * right.length > 120_000) {
    return [
      ...left.map((value) => ({ type: 'removed' as const, value })),
      ...right.map((value) => ({ type: 'added' as const, value })),
    ]
  }
  const width = right.length + 1
  const table = new Uint32Array((left.length + 1) * width)
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      table[i * width + j] = left[i - 1] === right[j - 1]
        ? table[(i - 1) * width + j - 1] + 1
        : Math.max(table[(i - 1) * width + j], table[i * width + j - 1])
    }
  }
  const operations: DiffOperation[] = []
  let i = left.length
  let j = right.length
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && left[i - 1] === right[j - 1]) {
      operations.push({ type: 'same', value: left[i - 1] }); i -= 1; j -= 1
    } else if (j > 0 && (i === 0 || table[i * width + j - 1] >= table[(i - 1) * width + j])) {
      operations.push({ type: 'added', value: right[j - 1] }); j -= 1
    } else {
      operations.push({ type: 'removed', value: left[i - 1] }); i -= 1
    }
  }
  return operations.reverse()
}

function wordDiff(base: string, alternative: string) {
  return sequenceDiff(base.split(/(\s+)/), alternative.split(/(\s+)/)).map((operation, index) => (
    operation.type === 'removed' ? <del key={index}>{operation.value}</del>
      : operation.type === 'added' ? <mark key={index}>{operation.value}</mark>
        : <span key={index}>{operation.value}</span>
  ))
}

function lineDiff(base: string, alternative: string) {
  return sequenceDiff(base.split('\n'), alternative.split('\n')).map((operation, index) => (
    <div key={index} data-change={operation.type}>
      <span aria-hidden="true">{operation.type === 'removed' ? '- ' : operation.type === 'added' ? '+ ' : '  '}</span>{operation.value || ' '}
    </div>
  ))
}

function Diff({ effective, value }: { effective: string; value: string }) {
  if (effective === value) return <p className="cc-diff-same">Matches the effective answer.</p>
  return valueKind(value) === 'structured'
    ? <pre className="cc-line-diff" aria-label="Line comparison">{lineDiff(effective, value)}</pre>
    : <p className="cc-word-diff" aria-label="Word comparison">{wordDiff(effective, value)}</p>
}

function SourceAnswer({ choice, effective, isEffective }: { choice: Contribution; effective: string; isEffective: boolean }) {
  return (
    <article className="cc-discrepancy-answer" data-effective={isEffective || undefined}>
      <header>
        <strong>{choice.sourceLayer}</strong>
        <span>{isEffective ? 'Effective now' : choice.fresherDissent ? 'Newer dissent' : 'Alternative'}</span>
      </header>
      <div className="cc-discrepancy-meta">Updated {formatDate(choice.updated)}</div>
      {!isEffective && <Diff effective={effective} value={choice.value} />}
      <details>
        <summary>Inspect full original value</summary>
        <Markdown className="cc-discrepancy-original" source={choice.value} />
      </details>
    </article>
  )
}

function History({ conflict }: { conflict: Conflict }) {
  if (!conflict.history.length) return <p className="cc-muted">No previous decisions.</p>
  return (
    <ol className="cc-discrepancy-history">
      {[...conflict.history].reverse().map((record) => (
        <li key={record.id}>
          <div className="cc-history-head">
            <strong>{record.action === 'acknowledge' ? 'Kept scoped difference' : record.action === 'compose' ? 'Wrote reconciled answer' : 'Used an existing answer'}</strong>
            <span>{formatDate(record.decidedAt)}</span>
          </div>
          <p>{record.reason}</p>
          <div className="cc-history-facts">
            <span>Actor: {record.actor}</span>
            <span>Result: {record.transactionState ?? 'committed'}</span>
            {record.ruleId && <span>Rule: {record.ruleId}</span>}
            {record.supersedes && <span>Superseded: {record.supersedes}</span>}
          </div>
          {record.writtenTargets?.length ? (
            <details><summary>{record.writtenTargets.length} affected files</summary><ul>{record.writtenTargets.map((target) => <li key={`${record.id}-${target.path}`}><code>{target.path}</code></li>)}</ul></details>
          ) : null}
          <details>
            <summary>Original answers and decision evidence</summary>
            {(record.contributions ?? []).map((item) => <div className="cc-history-original" key={`${record.id}-${item.layer}`}><strong>{item.layer}</strong><pre>{item.content}</pre></div>)}
          </details>
        </li>
      ))}
    </ol>
  )
}

function DecisionPanel({ conflict, onClose }: { conflict: Conflict; onClose: () => void }) {
  const { mode, decideDiscrepancy, setDiscrepancyPriority, resolvingConflict, resolutionError, openFilesScope } = useStoreData()
  const [action, setAction] = useState<'choose_contribution' | 'compose' | 'acknowledge'>('choose_contribution')
  const [selectedSource, setSelectedSource] = useState(conflict.effectiveSource ?? conflict.contributions[0]?.sourceLayer ?? '')
  // Starts EMPTY, never pre-filled with an existing contributor's value. A
  // compose field seeded with the old answer let a caret-position edit submit
  // old+new concatenated as the "reconciled" content — real on-disk
  // corruption in QA. "Start from <source>" below is the only way old content
  // enters this field, and it is an explicit click, never automatic.
  const [content, setContent] = useState('')
  const [reasonCode, setReasonCode] = useState<AcknowledgementReason | ''>('')
  const [note, setNote] = useState('')
  const [preview, setPreview] = useState(false)
  const busy = resolvingConflict === conflict.id
  const cannotWrite = conflict.kind === 'broken_link'
  // The engine 400s a compose against an array-typed frontmatter value (a
  // list field) — service.mjs rejects it outright. Disable the disposition
  // here instead of round-tripping into that error.
  const composeDisabled = conflict.kind === 'frontmatter_value' && conflict.isList === true
  const isFrontmatterValue = conflict.kind === 'frontmatter_value'
  const winningSource = conflict.effectiveSource ?? conflict.contributions[0]?.sourceLayer ?? null
  const winningValue = conflict.contributions.find((item) => item.sourceLayer === winningSource)?.value
  const reasonOptions = conflict.kind === 'broken_link'
    ? [...REASONS.slice(0, -1), TARGET_MISSING_REASON, REASONS[REASONS.length - 1]]
    : REASONS

  useEffect(() => {
    setAction('choose_contribution')
    setSelectedSource(conflict.effectiveSource ?? conflict.contributions[0]?.sourceLayer ?? '')
    setContent('')
    setReasonCode('')
    setNote('')
    setPreview(false)
  }, [conflict.id])

  const submit = async () => {
    if (!conflict.revision) return
    await decideDiscrepancy({
      discrepancyId: conflict.id, revision: conflict.revision, action,
      ...(action === 'choose_contribution' ? { selectedSource } : {}),
      ...(action === 'compose' ? { content } : {}),
      ...(action === 'acknowledge' && reasonCode ? { reasonCode, note } : {}),
    })
  }

  return (
    <div className="cc-decision-panel">
      {resolutionError && <div className="cc-conflict-error" role="alert"><strong>Decision not applied.</strong> {resolutionError.message}</div>}
      <fieldset>
        <legend>Choose a safe disposition</legend>
        <label><input type="radio" name="cc-disposition" checked={action === 'choose_contribution'} disabled={cannotWrite} onChange={() => setAction('choose_contribution')} /> <span><strong>Use this answer everywhere</strong><small>Propagate one existing answer to every writable contributor.</small></span></label>
        {action === 'choose_contribution' && <select aria-label="Answer to use" value={selectedSource} onChange={(event) => setSelectedSource(event.target.value)}>{conflict.contributions.map((item) => <option key={item.sourceLayer} value={item.sourceLayer}>{item.sourceLayer}</option>)}</select>}
        <label><input type="radio" name="cc-disposition" checked={action === 'compose'} disabled={cannotWrite || composeDisabled} onChange={() => setAction('compose')} /> <span><strong>Write a reconciled answer</strong><small>{isFrontmatterValue ? 'Compose a new value and propagate it to writable contributors.' : 'Compose a new Markdown value and propagate it to writable contributors.'}</small></span></label>
        {composeDisabled && <p className="cc-callout">This field is a list — pick an existing answer or edit the file directly.</p>}
        {action === 'compose' && (
          <div className="cc-compose">
            <textarea
              aria-label={isFrontmatterValue ? 'Reconciled value' : 'Reconciled Markdown'}
              placeholder="Write the reconciled answer — it replaces every writable contributor's value"
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
            <div className="cc-compose-actions">
              {winningSource && typeof winningValue === 'string' && !content && (
                <button type="button" onClick={() => setContent(winningValue)}>Start from {winningSource}</button>
              )}
              {!isFrontmatterValue && <button type="button" onClick={() => setPreview((value) => !value)}>{preview ? 'Edit Markdown' : 'Preview Markdown'}</button>}
            </div>
            {!isFrontmatterValue && preview && <Markdown className="cc-compose-preview" source={content} />}
          </div>
        )}
        <label><input type="radio" name="cc-disposition" checked={action === 'acknowledge'} onChange={() => setAction('acknowledge')} /> <span><strong>Keep the scoped difference</strong><small>Write no source content; record why the difference is intentional.</small></span></label>
        {action === 'acknowledge' && <div className="cc-acknowledge"><select aria-label="Acknowledgement reason" value={reasonCode} onChange={(event) => setReasonCode(event.target.value as AcknowledgementReason)}><option value="">Choose a required reason…</option>{reasonOptions.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}</select><textarea aria-label="Optional local note" placeholder="Optional local note (never learned into a rule)" value={note} onChange={(event) => setNote(event.target.value)} /></div>}
      </fieldset>
      {cannotWrite && <p className="cc-callout">Broken links require a source edit. Open the contributing file, or acknowledge why this link is intentionally unresolved.</p>}
      {!!conflict.affectedLinks?.length && (
        <div className="cc-callout">
          <strong>Affected links</strong>
          <ul>{conflict.affectedLinks.map((link) => <li key={link}><code>{link}</code></li>)}</ul>
        </div>
      )}
      <label className="cc-priority-assign"><span>Review priority</span><select aria-label="Assign priority" value={conflict.priority ?? 'unassigned'} onChange={(event) => void setDiscrepancyPriority(conflict.id, event.target.value)}><option value="unassigned">Unassigned</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
      <div className="cc-decision-actions">
        <button type="button" className="cc-button-primary" disabled={busy || (action === 'acknowledge' && !reasonCode) || (action === 'compose' && (composeDisabled || !content.trim())) || (action === 'choose_contribution' && cannotWrite)} onClick={() => void submit()}>
          {busy ? 'Applying…' : mode === 'demo' ? action === 'choose_contribution' ? `Simulate using ${selectedSource}` : action === 'compose' ? 'Simulate reconciled answer' : 'Simulate acknowledgement' : action === 'choose_contribution' ? `Use ${selectedSource} everywhere` : action === 'compose' ? 'Write reconciled answer' : 'Acknowledge difference'}
        </button>
        {conflict.contributions.map((item) => <button type="button" key={item.sourceLayer} onClick={() => openFilesScope(item.sourceLayer)}>Open {item.sourceLayer} files</button>)}
        <button type="button" onClick={onClose}>Leave open</button>
      </div>
    </div>
  )
}

function Rules() {
  const store = useStoreData()
  const { mode, approveRuleSuggestion, updateDiscrepancyRule, promoteDiscrepancyRule } = store
  const discrepancyRules = store.discrepancyRules ?? []
  const discrepancyRuleSuggestions = store.discrepancyRuleSuggestions ?? []
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null)
  return (
    <section className="cc-rules" aria-labelledby="cc-rules-heading">
      <div><h3 id="cc-rules-heading">Governed learning</h3><p>Repeated manual decisions can suggest structural rules. Confidence never grants permission.</p></div>
      {discrepancyRuleSuggestions.map((suggestion) => <article key={suggestion.id}><strong>Suggested from {suggestion.evidenceCount} decisions</strong><span>{suggestion.action.type === 'prefer_source' ? `Prefer ${suggestion.action.source}` : `Acknowledge as ${suggestion.action.reasonCode.replace(/_/g, ' ')}`}</span><details><summary>Inspect supporting decisions</summary><ul>{suggestion.evidenceDecisionIds.map((id) => <li key={id}><code>{id}</code></li>)}</ul></details><button type="button" disabled={mode === 'demo'} onClick={() => void approveRuleSuggestion(suggestion.id)}>Approve as recommendation</button></article>)}
      {discrepancyRules.map((rule) => <article key={rule.id}><strong>{rule.action.type === 'prefer_source' ? `Prefer ${rule.action.source}` : `Acknowledge: ${rule.action.reasonCode.replace(/_/g, ' ')}`}</strong><span>{rule.scope} · {rule.mode}</span><div><button type="button" disabled={mode === 'demo'} onClick={() => void updateDiscrepancyRule(rule.id, { enabled: !rule.enabled })}>{rule.enabled ? 'Disable' : 'Enable'}</button><button type="button" disabled={mode === 'demo' || !rule.enabled} onClick={() => void updateDiscrepancyRule(rule.id, { mode: rule.mode === 'automatic' ? 'recommend' : 'automatic' })}>{rule.mode === 'automatic' ? 'Return to recommend' : 'Enable automatic use'}</button>{rule.scope === 'local' && <button type="button" disabled={mode === 'demo'} onClick={async () => setPreview(await promoteDiscrepancyRule(rule.id, false))}>Preview team promotion</button>}</div></article>)}
      {preview?.requiresConfirmation === true && <div className="cc-rule-preview" role="dialog" aria-label="Team rule promotion preview"><h4>Promote as a team recommendation?</h4><pre>{JSON.stringify(preview.preview, null, 2)}</pre><button type="button" onClick={() => void promoteDiscrepancyRule(String((preview.preview as { id?: string }).id), true).then(() => setPreview(null))}>Confirm promotion</button><button type="button" onClick={() => setPreview(null)}>Cancel</button></div>}
      {!discrepancyRules.length && !discrepancyRuleSuggestions.length && <p className="cc-muted">No rules or suggestions yet. Suggestions appear after three consistent manual decisions.</p>}
    </section>
  )
}

function ConflictsInner() {
  const { mode, conflicts, setSelConflict, setQuery } = useStoreData()
  const { selConflict } = useStoreNav()
  const { query } = useStoreInput()
  const [status, setStatus] = useState('actionable')
  const [kind, setKind] = useState('all')
  const [owner, setOwner] = useState('all')
  const [source, setSource] = useState('all')
  const [priority, setPriority] = useState('all')
  const [newerOnly, setNewerOnly] = useState(false)
  const [detailOpen, setDetailOpen] = useState(Boolean(selConflict))
  const selectedButton = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const detail = useDetailSurface<HTMLDivElement, HTMLElement>(detailOpen)

  const owners = useMemo(() => [...new Set(conflicts.map((item) => item.owner ?? 'Unassigned'))].sort(), [conflicts])
  const sources = useMemo(() => [...new Set(conflicts.flatMap((item) => item.contributions.map((entry) => entry.sourceLayer)))].sort(), [conflicts])
  const normalizedQuery = (query ?? '').trim().toLowerCase()
  const visible = useMemo(() => conflicts.filter((item) => {
    const displayStatus = item.discrepancyStatus ?? (item.status === 'resolved' ? 'resolved' : 'needs_review')
    const statusMatch = status === 'all' || (status === 'actionable' ? ['needs_review', 'reopened'].includes(displayStatus) : status === 'automated' ? ['auto_ready', 'blocked'].includes(displayStatus) : displayStatus === status)
    return statusMatch && (kind === 'all' || item.kind === kind)
      && (owner === 'all' || (item.owner ?? 'Unassigned') === owner)
      && (source === 'all' || item.effectiveSource === source || item.contributions.some((entry) => entry.sourceLayer === source))
      && (priority === 'all' || (item.priority ?? 'unassigned') === priority)
      && (!newerOnly || item.contributions.some((entry) => entry.fresherDissent))
      && (!normalizedQuery || [item.concept, item.title, item.section, item.owner, item.kind, ...item.contributions.flatMap((entry) => [entry.sourceLayer, entry.value])].some((value) => String(value ?? '').toLowerCase().includes(normalizedQuery)))
  }), [conflicts, status, kind, owner, source, priority, newerOnly, normalizedQuery])
  const selected = visible.find((item) => item.id === selConflict) ?? visible[0] ?? null
  const actionable = conflicts.filter((item) => ['needs_review', 'reopened', 'recommended', 'auto_ready', 'blocked'].includes(item.discrepancyStatus ?? 'needs_review')).length

  useEffect(() => {
    const close = () => { setDetailOpen(false); requestAnimationFrame(() => selectedButton.current?.focus({ preventScroll: true })) }
    window.addEventListener('contextcake:close-detail', close)
    return () => window.removeEventListener('contextcake:close-detail', close)
  }, [])

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])]
    if (!buttons.length) return
    event.preventDefault()
    const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement))
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? Math.min(buttons.length - 1, current + 1) : Math.max(0, current - 1)
    buttons[next].focus(); buttons[next].click()
  }

  return (
    <div className="cc-conflicts cc-discrepancy-center">
      <header className="cc-discrepancy-header"><div><span className="cc-eyebrow">Alignment workspace</span><h2>Discrepancy Center</h2><p>{actionable} actionable {actionable === 1 ? 'item' : 'items'}. Structural evidence only—no model-inferred contradictions.</p></div><span className="cc-actionable-count">{actionable}</span></header>
      {conflicts.some((item) => item.coverageComplete === false) && <div className="cc-coverage-warning" role="status">Coverage is incomplete while sources index or recover. Broken-link findings are paused.</div>}
      <nav className="cc-status-tabs" aria-label="Discrepancy status"><button data-active={status === 'actionable'} onClick={() => setStatus('actionable')}>Needs review</button><button data-active={status === 'recommended'} onClick={() => setStatus('recommended')}>Recommendations</button><button data-active={status === 'automated'} onClick={() => setStatus('automated')}>Automated</button><button data-active={status === 'acknowledged'} onClick={() => setStatus('acknowledged')}>Acknowledged</button><button data-active={status === 'resolved'} onClick={() => setStatus('resolved')}>Resolved</button></nav>
      <div className="cc-discrepancy-filters" aria-label="Discrepancy filters"><select aria-label="Kind" value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">All kinds</option>{Object.entries(KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select aria-label="Owner" value={owner} onChange={(event) => setOwner(event.target.value)}><option value="all">All owners</option>{owners.map((value) => <option key={value}>{value}</option>)}</select><select aria-label="Source" value={source} onChange={(event) => setSource(event.target.value)}><option value="all">All sources</option>{sources.map((value) => <option key={value}>{value}</option>)}</select><select aria-label="Priority" value={priority} onChange={(event) => setPriority(event.target.value)}><option value="all">All priorities</option><option value="unassigned">Unassigned</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select><label className="cc-filter-check"><input type="checkbox" checked={newerOnly} onChange={(event) => setNewerOnly(event.target.checked)} /> Newer dissent</label></div>
      <div ref={detail.containerRef} className="cc-conflict-layout cc-navigator-detail">
        <div ref={listRef} className="cc-conflict-list" role="listbox" aria-label="Discrepancies" onKeyDown={onListKeyDown}>
          {visible.map((item) => { const selectedRow = item.id === selected?.id; const displayStatus = item.discrepancyStatus ?? 'needs_review'; return <button type="button" role="option" aria-selected={selectedRow} tabIndex={selectedRow ? 0 : -1} key={item.id} className="cc-conflict-row" data-selected={selectedRow} onClick={(event) => { selectedButton.current = event.currentTarget; setSelConflict(item.id); setDetailOpen(true) }}><span className="cc-conflict-row-top"><span className="cc-kind-pill">{KIND_LABEL[item.kind ?? 'section_content']}</span><span className="cc-conflict-row-status">{STATUS_LABEL[displayStatus]}</span></span><span className="cc-conflict-row-title">{item.section}</span><code>{item.concept}</code><span className="cc-conflict-row-foot"><span>{item.owner ?? 'Unassigned'} · {item.priority ?? 'unassigned'} priority</span><span>{item.contributions.length} sources</span></span></button> })}
          {!visible.length && (normalizedQuery
            ? <div className="cc-conflict-empty"><strong>No matches for &quot;{query.trim()}&quot; in this status.</strong><p>The search keeps filtering across status tabs until cleared.</p><button type="button" onClick={() => setQuery('')}>Clear search</button></div>
            : <div className="cc-conflict-empty"><strong>No discrepancies in this view</strong><p>Adjust the filters or return to Needs review.</p></div>)}
        </div>
        {selected && <section ref={detail.panelRef} {...detail.panelProps} className="cc-conflict-detail cc-navigator-detail-panel" data-open={detailOpen || undefined} aria-label={`${selected.title} discrepancy detail`}><button type="button" className="cc-detail-close" onClick={() => { setDetailOpen(false); requestAnimationFrame(() => selectedButton.current?.focus({ preventScroll: true })) }}>Close</button><div className="cc-discrepancy-path"><code>{selected.concept}</code><span>{selected.section}</span></div><div className="cc-discrepancy-title"><div><span className="cc-kind-pill">{KIND_LABEL[selected.kind ?? 'section_content']}</span><h2>Why this needs attention</h2></div><span className="cc-status-large">{STATUS_LABEL[selected.discrepancyStatus ?? 'needs_review']}</span></div><p className="cc-discrepancy-explanation">{selected.kind === 'broken_link' ? `The effective content links to ${selected.target}, but no settled source currently provides that concept.` : selected.kind === 'frontmatter_value' ? `Multiple contributors author different values for “${selected.section}”.` : selected.kind === 'changed_after_decision' ? 'A contributor changed after the previous decision, so the discrepancy reopened automatically.' : `Multiple contributors give materially different answers for “${selected.section}”.`}</p><div className="cc-evidence-grid"><div><span>Effective source</span><strong>{selected.effectiveSource ?? 'None'}</strong></div><div><span>Why it won</span><strong>{selected.winnerReason}</strong></div><div><span>Owner</span><strong>{selected.owner ?? 'Unassigned'}</strong></div><div><span>Source health</span><strong>{selected.sourceHealth?.every((item) => item?.status === 'ok') ? 'All healthy' : 'Needs attention'}</strong></div></div>{selected.ruleConflict && <div className="cc-conflict-error" role="alert"><strong>Rule conflict.</strong> Matching rules disagree, so no automatic action will run.</div>}{selected.matchingRules?.map((rule) => <div className="cc-rule-match" key={rule.id}>Matched {rule.scope} {rule.mode} rule <code>{rule.id}</code> from {rule.evidenceDecisionIds.length} decisions.</div>)}<section><h3>Compare every answer</h3><div className="cc-answer-stack">{selected.contributions.map((choice) => <SourceAnswer key={choice.sourceLayer} choice={choice} effective={selected.contributions.find((item) => item.sourceLayer === selected.effectiveSource)?.value ?? selected.contributions[0]?.value ?? ''} isEffective={choice.sourceLayer === selected.effectiveSource} />)}</div></section>{!['resolved', 'acknowledged'].includes(selected.discrepancyStatus ?? '') && <DecisionPanel conflict={selected} onClose={() => setDetailOpen(false)} />}<section><h3>Decision history</h3>{mode === 'demo' && <p className="cc-muted">Simulation history resets on reload.</p>}<History conflict={selected} /></section></section>}
      </div>
      <Rules />
    </div>
  )
}

/**
 * Memoized. The shell re-renders for its own reasons — a drawer, a dialog, a
 * background-activity tick — and this view has no business repainting for any
 * of them. It re-renders when the store slices it subscribes to change, and
 * otherwise not at all.
 */
export const Conflicts = memo(ConflictsInner)
