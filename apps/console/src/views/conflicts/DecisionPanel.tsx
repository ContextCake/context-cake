// The part of a discrepancy's detail that decides something. Two shapes:
//
//  - broken link: a suggested fix when the engine has one (rewrite to the
//    best candidate), the other candidates, remove-the-link, create the
//    missing concept in a writable layer, and the original "acknowledge for
//    now" / "open source concept" pair;
//  - everything else: the three dispositions (use one answer everywhere,
//    write a reconciled answer, keep the scoped difference).
//
// It renders a skeleton until the row carries its full record: a compact row
// has ≤240-char previews, and a compose seeded from a preview — or a diff of
// one — would be a lie the user could commit to disk.
import { useEffect, useState } from 'react'
import type { Conflict } from '../../data'
import type { AcknowledgementReason, DiscrepancyDecisionRequest } from '../../types'
import { Markdown } from '../../components/Markdown'
import { useStoreData } from '../../store'
import { reasonOptionsFor } from '../../conflict-reasons'
import { candidateReason } from './labels'
import { Skeleton } from './Evidence'

export type AppliedDecision =
  | { kind: 'single'; discrepancyId: string; status: 'acknowledged' | 'resolved'; message: string }
  | { kind: 'batch'; applied: number; failed: number; failedIds: string[]; message: string; suggestionId?: string; suggestionLabel?: string }

/** Layers a `create_stub` may write into: folder-backed sources the engine can open. */
export function writableLayerNames(sources: { name: string; sourceKind?: string; quarantined?: boolean }[] | undefined): string[] {
  return (sources ?? []).filter((source) => (source.sourceKind === 'okf-local' || source.sourceKind === 'files') && !source.quarantined).map((source) => source.name)
}

export function DecisionPanel({ conflict, onApplied }: { conflict: Conflict; onApplied: (notice: AppliedDecision) => void }) {
  const { mode, sources, decideDiscrepancy, setDiscrepancyPriority, resolvingConflict, resolutionError, openFilesScope, openConcept } = useStoreData()
  const brokenLink = conflict.kind === 'broken_link'
  const [action, setAction] = useState<'choose_contribution' | 'compose' | 'acknowledge'>(brokenLink ? 'acknowledge' : 'choose_contribution')
  const [selectedSource, setSelectedSource] = useState(conflict.effectiveSource ?? conflict.contributions[0]?.sourceLayer ?? '')
  // Starts EMPTY, never pre-filled with an existing contributor's value. A
  // compose field seeded with the old answer let a caret-position edit submit
  // old+new concatenated as the "reconciled" content — real on-disk
  // corruption in QA. "Start from <source>" below is the only way old content
  // enters this field, and it is an explicit click, never automatic.
  const [content, setContent] = useState('')
  const [reasonCode, setReasonCode] = useState<AcknowledgementReason | ''>(brokenLink ? 'target_missing' : '')
  const [note, setNote] = useState('')
  const [preview, setPreview] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const writableLayers = writableLayerNames(sources)
  const linkSource = conflict.effectiveSource ?? conflict.contributions[0]?.sourceLayer ?? null
  const [stubLayer, setStubLayer] = useState(() => (linkSource && writableLayers.includes(linkSource) ? linkSource : writableLayers[0] ?? ''))
  const busy = resolvingConflict === conflict.id
  // The engine 400s a compose against an array-typed frontmatter value (a
  // list field) — service.mjs rejects it outright. Disable the disposition
  // here instead of round-tripping into that error.
  const composeDisabled = conflict.kind === 'frontmatter_value' && conflict.isList === true
  const isFrontmatterValue = conflict.kind === 'frontmatter_value'
  const winningSource = conflict.effectiveSource ?? conflict.contributions[0]?.sourceLayer ?? null
  const winningValue = conflict.contributions.find((item) => item.sourceLayer === winningSource)?.value
  const reasonOptions = reasonOptionsFor(conflict.kind)
  const demo = mode === 'demo'

  useEffect(() => {
    setAction(conflict.kind === 'broken_link' ? 'acknowledge' : 'choose_contribution')
    setSelectedSource(conflict.effectiveSource ?? conflict.contributions[0]?.sourceLayer ?? '')
    setContent('')
    setReasonCode(conflict.kind === 'broken_link' ? 'target_missing' : '')
    setNote('')
    setPreview(false)
    setAttempted(false)
  }, [conflict.id])

  // Keyed on the NAMES, not the array (a fresh array per render): the layer
  // picker only moves when a writable layer appears or goes away, or when
  // the row's own source changes.
  const writableKey = writableLayers.join('|')
  useEffect(() => {
    const names = writableKey ? writableKey.split('|') : []
    setStubLayer((current) => {
      if (current && names.includes(current)) return current
      return linkSource && names.includes(linkSource) ? linkSource : names[0] ?? ''
    })
  }, [writableKey, linkSource])

  const submit = async () => {
    if (!conflict.revision) return
    setAttempted(true)
    try {
      await decideDiscrepancy({
        discrepancyId: conflict.id, revision: conflict.revision, action,
        ...(action === 'choose_contribution' ? { selectedSource } : {}),
        ...(action === 'compose' ? { content } : {}),
        ...(action === 'acknowledge' && reasonCode ? { reasonCode, note } : {}),
      })
      onApplied({
        kind: 'single',
        discrepancyId: conflict.id,
        status: action === 'acknowledge' ? 'acknowledged' : 'resolved',
        message: action === 'acknowledge'
          ? `Acknowledged “${conflict.section}”. No files changed.`
          : `Resolved “${conflict.section}”. The file changes are recorded in its decision history.`,
      })
    } catch { /* The store exposes resolutionError; keep the panel open so the user can retry. */ }
  }

  const markBrokenLinkWaiting = async () => {
    if (!conflict.revision) return
    setAttempted(true)
    try {
      await decideDiscrepancy({
        discrepancyId: conflict.id,
        revision: conflict.revision,
        action: 'acknowledge',
        reasonCode: 'target_missing',
        note: '',
      })
      onApplied({
        kind: 'single',
        discrepancyId: conflict.id,
        status: 'acknowledged',
        message: `Acknowledged “${conflict.target}” as Target not created yet. No files changed.`,
      })
    } catch { /* The store exposes resolutionError; keep the panel open so the user can retry. */ }
  }

  /** The three link fixes share one shape: a decision on this row that changes a file. */
  const fixLink = async (request: Pick<DiscrepancyDecisionRequest, 'action' | 'newTarget' | 'layer'>, message: string) => {
    if (!conflict.revision) return
    setAttempted(true)
    try {
      await decideDiscrepancy({ discrepancyId: conflict.id, revision: conflict.revision, ...request })
      onApplied({ kind: 'single', discrepancyId: conflict.id, status: 'resolved', message })
    } catch { /* resolutionError renders above; the panel stays for a retry */ }
  }

  if (conflict.detailLoaded === false) {
    return <div className="cc-decision-panel"><Skeleton lines={4} label="Loading the full record" /></div>
  }

  if (brokenLink) {
    const source = linkSource
    const best = conflict.bestCandidate ?? null
    const others = (conflict.candidates ?? []).filter((candidate) => candidate.id !== best?.id)
    const target = conflict.target ?? ''
    return (
      <div className="cc-decision-panel cc-broken-link-panel">
        {attempted && resolutionError && <div className="cc-conflict-error" role="alert"><strong>Decision not applied.</strong> {resolutionError.message}</div>}
        {best ? (
          <section className="cc-smart-resolution" aria-labelledby={`recommended-${conflict.id}`}>
            <div className="cc-smart-resolution-copy">
              <span className="cc-recommendation-label">Suggested fix</span>
              <h3 id={`recommended-${conflict.id}`}>Rewrite to <code>{best.id}</code></h3>
              <p>
                An existing concept that {candidateReason(best)} ({Math.round(best.confidence * 100)}% match).
                Rewrites this one link in {source ?? 'the source'}'s file; other links to <code>{target}</code> stay as they are.
              </p>
            </div>
            <button
              type="button"
              className="cc-button-primary"
              disabled={busy || !conflict.revision}
              onClick={() => void fixLink({ action: 'rewrite_link', newTarget: best.id }, `Rewrote the link to “${best.id}” in ${source ?? 'the source'}. The file change is recorded in its decision history.`)}
            >{busy ? 'Applying…' : demo ? 'Simulate rewrite' : 'Rewrite link'}</button>
          </section>
        ) : (
          <section className="cc-smart-resolution" aria-labelledby={`recommended-${conflict.id}`}>
            <div className="cc-smart-resolution-copy">
              <span className="cc-recommendation-label">Recommended</span>
              <h3 id={`recommended-${conflict.id}`}>Keep the link for now</h3>
              <p>
                Record <strong>Target not created yet</strong>. No files change; this moves the item to Acknowledged.
                ContextCake rechecks links when sources change.
              </p>
            </div>
            <button
              type="button"
              className="cc-button-primary"
              disabled={busy || !conflict.revision}
              onClick={() => void markBrokenLinkWaiting()}
            >{busy ? 'Applying…' : demo ? 'Simulate acknowledging' : 'Acknowledge for now'}</button>
          </section>
        )}
        <div className="cc-link-fixes" aria-label="Other ways to fix this link">
          <strong>{best ? 'Other ways to fix it' : 'Fix it now'}</strong>
          {others.length > 0 && (
            <ul className="cc-link-candidates">
              {others.map((candidate) => (
                <li key={candidate.id}>
                  <span><code>{candidate.id}</code><small>{candidateReason(candidate)} · {Math.round(candidate.confidence * 100)}%</small></span>
                  <button type="button" disabled={busy || !conflict.revision} onClick={() => void fixLink({ action: 'rewrite_link', newTarget: candidate.id }, `Rewrote the link to “${candidate.id}” in ${source ?? 'the source'}. The file change is recorded in its decision history.`)}>{demo ? 'Simulate rewrite' : 'Rewrite to this'}</button>
                </li>
              ))}
            </ul>
          )}
          <div className="cc-link-fix-row">
            <span><strong>Remove the link</strong><small>Keeps the link text as plain words in {source ?? 'the source'}'s file.</small></span>
            <button type="button" disabled={busy || !conflict.revision} onClick={() => void fixLink({ action: 'unlink' }, `Removed the link to “${target}” from ${source ?? 'the source'}. The file change is recorded in its decision history.`)}>{demo ? 'Simulate removal' : 'Remove link'}</button>
          </div>
          <div className="cc-link-fix-row">
            <span>
              <strong>Create <code>{target}</code></strong>
              <small>A minimal concept file, so every link to it resolves. The created file is the audit trail.</small>
            </span>
            <span className="cc-link-fix-controls">
              <select aria-label="Layer to create the concept in" value={stubLayer} disabled={busy || writableLayers.length === 0} onChange={(event) => setStubLayer(event.target.value)}>
                {writableLayers.length === 0 && <option value="">No writable layer</option>}
                {writableLayers.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              <button type="button" disabled={busy || !conflict.revision || !stubLayer} onClick={() => void fixLink({ action: 'create_stub', layer: stubLayer }, `Created “${target}” in ${stubLayer}. Every link to it now resolves.`)}>{demo ? 'Simulate creating' : 'Create'}</button>
            </span>
          </div>
          {best && (
            <div className="cc-link-fix-row">
              <span><strong>Keep the link for now</strong><small>Record <strong>Target not created yet</strong>; no files change.</small></span>
              <button type="button" disabled={busy || !conflict.revision} onClick={() => void markBrokenLinkWaiting()}>{demo ? 'Simulate acknowledging' : 'Acknowledge for now'}</button>
            </div>
          )}
        </div>
        <div className="cc-broken-link-fix">
          <div>
            <strong>Want to edit it by hand?</strong>
            <p>Open the source concept, then edit or remove the link in its {source ?? 'contributing'} file.</p>
          </div>
          <button type="button" onClick={() => openConcept(conflict.concept)}>Open source concept</button>
        </div>
        <details className="cc-more-options" onToggle={(event) => {
          if (event.currentTarget.open && reasonCode === 'target_missing') setReasonCode('')
        }}>
          <summary>More options</summary>
          <div className="cc-more-options-body">
            <div className="cc-acknowledge">
              <strong>Acknowledge with a different reason</strong>
              <select aria-label="Acknowledgement reason" value={reasonCode} onChange={(event) => setReasonCode(event.target.value as AcknowledgementReason)}>
                <option value="">Choose a required reason…</option>
                {reasonOptions.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
              </select>
              <textarea aria-label="Optional local note" placeholder="Optional local note (never learned into a rule)" value={note} onChange={(event) => setNote(event.target.value)} />
              <button type="button" disabled={busy || !reasonCode || !conflict.revision} onClick={() => void submit()}>{busy ? 'Applying…' : demo ? 'Simulate acknowledgement' : 'Acknowledge with this reason'}</button>
            </div>
            <label className="cc-priority-assign"><span>Review priority</span><select aria-label="Assign priority" value={conflict.priority ?? 'unassigned'} onChange={(event) => void setDiscrepancyPriority(conflict.id, event.target.value)}><option value="unassigned">Unassigned</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
          </div>
        </details>
      </div>
    )
  }

  return (
    <div className="cc-decision-panel">
      {attempted && resolutionError && <div className="cc-conflict-error" role="alert"><strong>Decision not applied.</strong> {resolutionError.message}</div>}
      <fieldset>
        <legend>Choose a safe disposition</legend>
        <label><input type="radio" name="cc-disposition" checked={action === 'choose_contribution'} onChange={() => setAction('choose_contribution')} /> <span><strong>Use this answer everywhere</strong><small>Propagate one existing answer to every writable contributor.</small></span></label>
        {action === 'choose_contribution' && <select aria-label="Answer to use" value={selectedSource} onChange={(event) => setSelectedSource(event.target.value)}>{conflict.contributions.map((item) => <option key={item.sourceLayer} value={item.sourceLayer}>{item.sourceLayer}</option>)}</select>}
        <label><input type="radio" name="cc-disposition" checked={action === 'compose'} disabled={composeDisabled} onChange={() => setAction('compose')} /> <span><strong>Write a reconciled answer</strong><small>{isFrontmatterValue ? 'Compose a new value and propagate it to writable contributors.' : 'Compose a new Markdown value and propagate it to writable contributors.'}</small></span></label>
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
      {!!conflict.affectedLinks?.length && (
        <div className="cc-callout">
          <strong>Affected links</strong>
          <ul>{conflict.affectedLinks.map((link) => <li key={link}><code>{link}</code></li>)}</ul>
        </div>
      )}
      <label className="cc-priority-assign"><span>Review priority</span><select aria-label="Assign priority" value={conflict.priority ?? 'unassigned'} onChange={(event) => void setDiscrepancyPriority(conflict.id, event.target.value)}><option value="unassigned">Unassigned</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
      <div className="cc-decision-actions">
        <button type="button" className="cc-button-primary" disabled={busy || (action === 'acknowledge' && !reasonCode) || (action === 'compose' && (composeDisabled || !content.trim()))} onClick={() => void submit()}>
          {busy ? 'Applying…' : demo ? action === 'choose_contribution' ? `Simulate using ${selectedSource}` : action === 'compose' ? 'Simulate reconciled answer' : 'Simulate acknowledgement' : action === 'choose_contribution' ? `Use ${selectedSource} everywhere` : action === 'compose' ? 'Write reconciled answer' : 'Acknowledge difference'}
        </button>
        {conflict.contributions.map((item) => <button type="button" key={item.sourceLayer} onClick={() => openFilesScope(item.sourceLayer)}>Open {item.sourceLayer} files</button>)}
      </div>
    </div>
  )
}
