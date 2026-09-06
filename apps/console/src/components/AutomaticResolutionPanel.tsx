import { useCallback, useEffect, useRef, useState } from 'react'
import { LocalDiscrepancyAssessment } from './LocalDiscrepancyAssessment'
import { apiFetch } from '../api'
import type { Conflict } from '../data'
import { useStoreData } from '../store'

interface Policy {
  id: string; conceptId: string; key: string; selectedSource: string; enabled: boolean; version: number
}
interface Decision {
  id: string; conceptId: string; key: string; selectedSource: string; createdAt: string; undoneAt?: string
  currentStatus?: 'applied' | 'stale' | 'undone'
}
interface ResolutionState { version: number; revision: number; policies: Policy[]; decisions: Decision[] }

/** Exact source authority is a standing policy, not a model's confidence score. */
export function AutomaticResolutionPanel({ conflict, defaultExpanded = false }: { conflict: Conflict | null; defaultExpanded?: boolean }) {
  const { reload, reloadKey, conflicts } = useStoreData()
  const [state, setState] = useState<ResolutionState | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [selectedSource, setSelectedSource] = useState('')
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [unavailable, setUnavailable] = useState(false)
  const reading = useRef<AbortController | null>(null)
  const refresh = useCallback(async () => {
    reading.current?.abort()
    const controller = new AbortController()
    reading.current = controller
    try {
      const response = await apiFetch('/api/context-resolutions', { signal: controller.signal })
      if (reading.current !== controller || controller.signal.aborted) return
      if (response.status === 404) { setUnavailable(true); return }
      if (!response.ok) throw new Error('Could not read automatic resolution policies. Try again.')
      const next = await response.json() as ResolutionState
      if (reading.current !== controller || controller.signal.aborted) return
      if (!Array.isArray(next.policies) || !Array.isArray(next.decisions)) throw new Error('The engine returned an incomplete policy response.')
      setState(next); setUnavailable(false); setError('')
    } catch (err) {
      if (reading.current === controller && !controller.signal.aborted) throw err
    }
  }, [])
  // The store replaces this list on content/policy changes, not UI keystrokes.
  useEffect(() => {
    let active = true
    void refresh().catch((err) => { if (active) setError(String(err.message ?? err)) })
    return () => { active = false; reading.current?.abort(); reading.current = null }
  }, [refresh, reloadKey, conflicts])
  useEffect(() => { setSelectedSource(''); setNotice('') }, [conflict?.id])

  const eligible = conflict && (conflict.originalKind ?? conflict.kind) === 'section_content' && conflict.revision && conflict.detailLoaded !== false
  const selected = conflict?.contributions.find((item) => item.sourceLayer === selectedSource)
  const latestBySection = new Map(state?.decisions.map((decision) => [JSON.stringify([decision.conceptId, decision.key]), decision.id]) ?? [])
  const enabledCount = state?.policies.filter((policy) => policy.enabled).length ?? 0
  const mutate = async (method: string, body: Record<string, unknown>, message: string) => {
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await apiFetch('/api/context-resolutions', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const result = await response.json().catch(() => ({})) as { error?: string; message?: string }
      if (!response.ok) throw new Error(result.error || result.message || `The engine declined this change (${response.status}).`)
      // A successful write and a verified read are separate outcomes.
      reload()
      setNotice(message)
      await refresh()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  return <section className="cc-auto-resolution" aria-labelledby="cc-auto-resolution-title">
    <div className="cc-auto-resolution-heading"><div><h2 id="cc-auto-resolution-title">Automatic context resolution</h2><p>Trust a source for an exact section. ContextCake applies that policy as its evidence changes and preserves the original files.</p></div><button type="button" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>{expanded ? 'Hide policies' : `Manage policies${enabledCount ? ` (${enabledCount} enabled)` : ''}`}</button></div>
    {expanded && <div className="cc-auto-resolution-body">
      {unavailable ? <p>This engine does not support context resolution policies yet.</p> : <>
        {!state && !error && <p role="status">Loading policies…</p>}
        {eligible ? <div className="cc-auto-policy-form">
          <h3>{conflict.conceptTitle ?? conflict.title} · {conflict.section}</h3>
          <code>{conflict.concept} / {conflict.sectionKey}</code>
          <label>Authoritative source<select aria-label="Authoritative source for this section" value={selectedSource} onChange={(event) => setSelectedSource(event.target.value)}><option value="">Choose a source…</option>{conflict.contributions.map((item) => <option key={item.sourceLayer} value={item.sourceLayer}>{item.sourceLayer}</option>)}</select></label>
          {selected && <><blockquote>{selected.value}</blockquote><p>Enabling this policy allows <strong>{selectedSource}</strong> to supply <strong>{conflict.section}</strong> in <strong>{conflict.concept}</strong> now and on future changes, without another approval. ContextCake rechecks the evidence before applying it. Other sections keep their existing precedence.</p></>}
          <button type="button" disabled={busy || !state || !selected} onClick={() => void mutate('POST', { conceptId: conflict.concept, key: conflict.sectionKey, selectedSource, revision: conflict.revision }, 'Source policy enabled. The resolved context has been refreshed.')}>Enable this source policy</button>
        </div> : <p>Select a section-content discrepancy to create a source policy. Broken links and uncertain evidence use their own checks.</p>}
        {eligible && <LocalDiscrepancyAssessment key={`${conflict.id}:${conflict.revision}`} conflict={conflict} />}
        {state && <div className="cc-auto-policy-history"><h3>Source policies</h3>{state.policies.length === 0 ? <p>No source policies enabled.</p> : state.policies.map((policy) => <div className="cc-auto-policy-row" key={policy.id}><span><strong>{policy.selectedSource}</strong><code>{policy.conceptId} / {policy.key}</code><small>{policy.enabled ? 'Enabled for future changes' : 'Paused'}</small></span>{policy.enabled && <button type="button" disabled={busy} onClick={() => void mutate('PATCH', { policyId: policy.id }, 'Policy paused. Previous decisions remain in history.')}>Pause</button>}</div>)}
          <h3>Resolution history</h3>{state.decisions.length === 0 ? <p>No context resolutions recorded.</p> : state.decisions.slice(-20).reverse().map((decision) => <div className="cc-auto-policy-row" key={decision.id}><span><strong>{decision.selectedSource}</strong><code>{decision.conceptId} / {decision.key}</code><small>{decision.undoneAt ? 'Undone' : decision.currentStatus === 'applied' ? 'Applied to current evidence' : decision.currentStatus === 'stale' ? 'Not currently applicable — original cascade shown' : 'Recorded decision'} · {new Date(decision.createdAt).toLocaleString()}</small></span>{!decision.undoneAt && latestBySection.get(JSON.stringify([decision.conceptId, decision.key])) === decision.id && <button type="button" disabled={busy} onClick={() => void mutate('DELETE', { decisionId: decision.id }, 'Resolution undone and policy paused. Original context restored.')}>Undo</button>}</div>)}{state.decisions.length > 20 && <p>Showing the latest 20 decisions.</p>}
        </div>}
      </>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error} <button type="button" disabled={busy} onClick={() => { setError(''); void refresh().catch((err) => setError(String(err.message ?? err))) }}>Retry reading policies</button></p>}
    </div>}
  </section>
}
