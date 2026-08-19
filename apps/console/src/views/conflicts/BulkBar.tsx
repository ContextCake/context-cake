// Acts on the selection. Every action here goes through the batch route
// twice: a dry run first — "17 files change across 2 layers" — and only then
// the real one, once the user has seen that sentence. Which actions appear
// depends on what the selected rows have in common (describeItems): all
// broken links to one target can be rewritten or given a stub concept, any
// broken links can be unlinked, rows sharing a source can all take it, and
// anything can be acknowledged with a reason.
import { useEffect, useMemo, useState } from 'react'
import type { Conflict } from '../../data'
import type { AcknowledgementReason, DiscrepancyBatchRequest, DiscrepancyBatchResponse, DiscrepancyDecisionRequest } from '../../types'
import { describeItems, isActionable } from '../../discrepancy-summary'
import { reasonOptionsFor } from '../../conflict-reasons'
import { useStoreData } from '../../store'
import { writableLayerNames } from './DecisionPanel'
import { candidateReason, plural } from './labels'

export interface BulkOutcome {
  label: string
  request: DiscrepancyBatchRequest
  response: DiscrepancyBatchResponse
}

export interface BulkBarProps {
  /** The selected rows, in list order. */
  items: Conflict[]
  onClear: () => void
  onOutcome: (outcome: BulkOutcome) => void
}

interface Pending {
  label: string
  request: DiscrepancyBatchRequest
  preview: DiscrepancyBatchResponse
}

/** "17 files change across 2 layers." — what a dry run says will happen. */
export function previewSentence(preview: DiscrepancyBatchResponse, { acknowledging = false } = {}): string {
  const files = new Set<string>()
  const layers = new Set<string>()
  for (const result of preview.results) {
    for (const write of result.wouldWrite ?? []) { files.add(`${write.layer}/${write.path}`); layers.add(write.layer) }
  }
  const okCount = preview.results.filter((result) => result.ok).length
  const refused = preview.results.filter((result) => !result.ok)
  const parts: string[] = []
  if (preview.fallback === 'sequential') {
    parts.push(`This engine cannot preview changes; ${plural(okCount, 'decision')} will apply one at a time.`)
  } else if (files.size === 0) {
    parts.push(acknowledging ? `No files change. ${plural(okCount, 'item')} move to Acknowledged.` : `No files change for ${plural(okCount, 'item')}.`)
  } else {
    parts.push(`${plural(files.size, 'file')} change across ${plural(layers.size, 'layer')} for ${plural(okCount, 'item')}.`)
  }
  if (refused.length > 0) {
    const first = refused[0]
    parts.push(`${refused.length} cannot be applied${first.error ? ` (${first.error})` : first.code ? ` (${first.code})` : ''}.`)
  }
  return parts.join(' ')
}

export function BulkBar({ items, onClear, onOutcome }: BulkBarProps) {
  const { mode, sources, decideDiscrepancies, resolvingConflict } = useStoreData()
  const demo = mode === 'demo'
  const busy = resolvingConflict === 'batch'
  const decidable = useMemo(() => items.filter((item) => isActionable(item) && item.revision), [items])
  const description = useMemo(() => describeItems(decidable), [decidable])
  const writableLayers = writableLayerNames(sources)

  const [ackOpen, setAckOpen] = useState(false)
  const [reasonCode, setReasonCode] = useState<AcknowledgementReason | ''>('')
  const [note, setNote] = useState('')
  const [rewriteTarget, setRewriteTarget] = useState('')
  const [stubLayer, setStubLayer] = useState('')
  const [useSource, setUseSource] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [error, setError] = useState<string | null>(null)

  const defaultRewrite = description.sharedBestCandidate?.id ?? description.candidates[0]?.id ?? ''
  useEffect(() => { setRewriteTarget((current) => (current && description.candidates.some((c) => c.id === current) ? current : defaultRewrite)) }, [defaultRewrite, description.candidates])
  const writableKey = writableLayers.join('|')
  useEffect(() => {
    const names = writableKey ? writableKey.split('|') : []
    setStubLayer((current) => (current && names.includes(current) ? current : names[0] ?? ''))
  }, [writableKey])
  const sharedSourcesKey = (description.sharedSources ?? []).join('|')
  useEffect(() => {
    const names = sharedSourcesKey ? sharedSourcesKey.split('|') : []
    setUseSource((current) => (current && names.includes(current) ? current : names[0] ?? ''))
  }, [sharedSourcesKey])
  // A changed selection invalidates a preview: it was computed for other rows.
  const selectionKey = decidable.map((item) => item.id).join('|')
  useEffect(() => { setPending(null); setError(null) }, [selectionKey])

  const canRewrite = description.allBrokenLinks && Boolean(description.sharedTarget) && description.candidates.length > 0
  const canUnlink = description.allBrokenLinks
  const canCreate = description.allBrokenLinks && Boolean(description.sharedTarget) && writableLayers.length > 0
  const canUseSource = !description.anyBrokenLink && (description.sharedSources?.length ?? 0) > 0
  const reasonOptions = reasonOptionsFor(description.allBrokenLinks ? 'broken_link' : 'section_content')

  const decisionsFor = (build: (item: Conflict) => Omit<DiscrepancyDecisionRequest, 'discrepancyId' | 'revision'>): DiscrepancyDecisionRequest[] =>
    decidable.map((item) => ({ discrepancyId: item.id, revision: item.revision as string, ...build(item) }))

  const preview = async (label: string, decisions: DiscrepancyDecisionRequest[]) => {
    if (busy || decisions.length === 0) return
    setError(null)
    try {
      const response = await decideDiscrepancies({ decisions, dryRun: true })
      setPending({ label, request: { decisions }, preview: response })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const apply = async () => {
    if (!pending || busy) return
    setError(null)
    try {
      const response = await decideDiscrepancies(pending.request)
      onOutcome({ label: pending.label, request: pending.request, response })
      setPending(null)
      setAckOpen(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const n = decidable.length
  const target = description.sharedTarget

  return (
    <div className="cc-bulk-bar" role="region" aria-label="Bulk actions">
      <div className="cc-bulk-bar-head">
        <strong>{plural(items.length, 'selected', 'selected')}</strong>
        {n !== items.length && <span className="cc-bulk-note">{n} can still be decided</span>}
        <button type="button" className="cc-bulk-clear" onClick={onClear}>Clear</button>
      </div>
      {n === 0 ? (
        <p className="cc-bulk-note">Nothing in this selection is open — acknowledged and resolved items are already decided.</p>
      ) : pending ? (
        <div className="cc-bulk-confirm" role="group" aria-label="Confirm bulk action">
          <p><strong>{pending.label}.</strong> {previewSentence(pending.preview, { acknowledging: pending.request.decisions[0]?.action === 'acknowledge' })}</p>
          <div className="cc-bulk-actions">
            <button type="button" className="cc-button-primary" disabled={busy || pending.preview.results.every((result) => !result.ok)} onClick={() => void apply()}>
              {busy ? 'Applying…' : demo ? `Simulate for ${pending.preview.results.filter((result) => result.ok).length}` : `Apply to ${pending.preview.results.filter((result) => result.ok).length}`}
            </button>
            <button type="button" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="cc-bulk-actions">
          {canRewrite && (
            <span className="cc-bulk-group">
              <button type="button" disabled={busy || !rewriteTarget} onClick={() => void preview(`Rewrite ${plural(n, 'link')} to ${rewriteTarget}`, decisionsFor(() => ({ action: 'rewrite_link', newTarget: rewriteTarget })))}>
                Rewrite {plural(n, 'link')} →
              </button>
              <select aria-label="Rewrite links to" value={rewriteTarget} disabled={busy} onChange={(event) => setRewriteTarget(event.target.value)}>
                {description.candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>{candidate.id} · {candidateReason(candidate)}{description.sharedBestCandidate?.id === candidate.id ? ' · suggested' : ''}</option>
                ))}
              </select>
            </span>
          )}
          {canUnlink && (
            <button type="button" disabled={busy} onClick={() => void preview(`Remove ${plural(n, 'link')}`, decisionsFor(() => ({ action: 'unlink' })))}>Remove {plural(n, 'link')}</button>
          )}
          {canCreate && target && (
            <span className="cc-bulk-group">
              <button type="button" disabled={busy || !stubLayer} onClick={() => void preview(`Create ${target} in ${stubLayer}`, [{ discrepancyId: decidable[0].id, revision: decidable[0].revision as string, action: 'create_stub', layer: stubLayer }])} title="One new concept file; every selected link resolves to it">
                Create <code>{target}</code> in
              </button>
              <select aria-label="Layer to create the concept in" value={stubLayer} disabled={busy} onChange={(event) => setStubLayer(event.target.value)}>
                {writableLayers.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </span>
          )}
          {canUseSource && (
            <span className="cc-bulk-group">
              <button type="button" disabled={busy || !useSource} onClick={() => void preview(`Use ${useSource} for ${plural(n, 'item')}`, decisionsFor(() => ({ action: 'choose_contribution', selectedSource: useSource })))}>Use</button>
              <select aria-label="Source to use everywhere" value={useSource} disabled={busy} onChange={(event) => setUseSource(event.target.value)}>
                {(description.sharedSources ?? []).map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              <span className="cc-bulk-note">for {plural(n, 'item')}</span>
            </span>
          )}
          {!ackOpen ? (
            <button type="button" disabled={busy} onClick={() => setAckOpen(true)}>Acknowledge {n}…</button>
          ) : (
            <span className="cc-bulk-group cc-bulk-ack">
              <select aria-label="Acknowledgement reason" value={reasonCode} disabled={busy} onChange={(event) => setReasonCode(event.target.value as AcknowledgementReason)}>
                <option value="">Choose a required reason…</option>
                {reasonOptions.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
              </select>
              <input type="text" aria-label="Optional local note" placeholder="Optional local note" value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} />
              <button type="button" disabled={busy || !reasonCode} onClick={() => void preview(`Acknowledge ${plural(n, 'item')}`, decisionsFor(() => ({ action: 'acknowledge', reasonCode: reasonCode as AcknowledgementReason, note })))}>Preview</button>
              <button type="button" disabled={busy} onClick={() => setAckOpen(false)}>Cancel</button>
            </span>
          )}
        </div>
      )}
      {error && <p className="cc-conflict-error" role="alert"><strong>Not applied.</strong> {error}</p>}
    </div>
  )
}
