import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../api'
import type { Conflict } from '../data'
interface LocalModel { name: string; digest: string; size: number }
interface Assessment {
  category: string; selectedSource: string | null; rationale: string
  citations: { source: string; quote: string }[]; missingEvidence: string[] | string
  advisoryOnly: true; automaticallyApplicable: false
}
export function LocalDiscrepancyAssessment({ conflict }: { conflict: Conflict }) {
  const [models, setModels] = useState<LocalModel[] | null>(null)
  const [modelDigest, setModelDigest] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const [assessment, setAssessment] = useState<Assessment | null>(null)
  const request = useRef<AbortController | null>(null)
  // Discrepancy revisions fingerprint text/levels, but advice also relies on
  // authored dates and coverage. Retire both pending and completed advice.
  const evidenceKey = JSON.stringify([conflict.id, conflict.revision, conflict.contributions, conflict.sourceHealth, conflict.coverageComplete, conflict.ruleConflict])
  useEffect(() => {
    request.current?.abort(); request.current = null
    setAssessment(null); setError(''); setBusy(false)
    return () => { request.current?.abort(); request.current = null }
  }, [evidenceKey])
  const model = models?.find((item) => item.digest === modelDigest)
  const checkModels = async () => {
    setBusy(true); setError(''); setAssessment(null)
    const controller = new AbortController(); request.current = controller
    try {
      const response = await apiFetch('/api/discrepancy-assessment/models', { signal: controller.signal })
      if (!response.ok) throw new Error('Local model discovery is unavailable in this engine.')
      const data = await response.json() as { available: boolean; models: LocalModel[] }
      if (controller.signal.aborted) return
      setUnavailable(!data.available); setModels(data.models ?? [])
    } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  const assess = async () => {
    if (!model || !conflict.revision) return
    const controller = new AbortController(); request.current?.abort(); request.current = controller
    const timeout = setTimeout(() => controller.abort(), 60_000)
    setBusy(true); setError(''); setAssessment(null)
    try {
      const response = await apiFetch('/api/discrepancy-assessment', { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ discrepancyId: conflict.id, revision: conflict.revision, model: model.name, digest: model.digest }) })
      const data = await response.json() as { assessment?: Assessment; error?: string }
      if (!response.ok) throw new Error(data.error ?? 'The assessment could not be completed.')
      if (!data.assessment || data.assessment.advisoryOnly !== true || data.assessment.automaticallyApplicable !== false) throw new Error('The engine returned an unsupported assessment. No policy was changed.')
      if (!controller.signal.aborted) setAssessment(data.assessment)
    } catch (err) { if (request.current === controller) setError(controller.signal.aborted ? 'The assessment timed out. No policy was changed.' : err instanceof Error ? err.message : String(err)) }
    finally { clearTimeout(timeout); if (request.current === controller) setBusy(false) }
  }
  return <div className="cc-local-assessment"><h3>Advisory assessment</h3><p>An installed local model can compare the evidence. Its suggestion may be wrong and never enables a policy or changes your source choice.</p>
    {models === null ? <button type="button" disabled={busy} onClick={() => void checkModels()}>Check local models</button> : unavailable ? <p>Local model assessment requires the desktop app and a running local model runtime.</p> : models.length === 0 ? <p>No installed models found. Start your local model runtime, then check again.</p> : <><label>Installed model<select aria-label="Local assessment model" value={modelDigest} disabled={busy} onChange={(event) => { setModelDigest(event.target.value); setAssessment(null) }}><option value="">Choose an installed model…</option>{models.map((item) => <option key={item.digest} value={item.digest}>{item.name} · {(item.size / 1e9).toFixed(1)} GB</option>)}</select></label><button type="button" disabled={busy || !model} onClick={() => void assess()}>Assess locally</button></>}
    {models !== null && !busy && <button type="button" onClick={() => void checkModels()}>Refresh local models</button>}
    {busy && <p role="status">{model ? 'Assessing the evidence locally… This can take up to a minute.' : 'Checking installed models…'}</p>}
    {error && <p role="alert">{error}</p>}
    {assessment && <div className="cc-local-assessment-result"><strong>Advisory result · {assessment.category}</strong><p>{assessment.rationale}</p>{assessment.selectedSource && <p>Suggested source: <strong>{assessment.selectedSource}</strong></p>}{assessment.citations.map((citation, index) => <blockquote key={index}><strong>{citation.source}</strong><p>{citation.quote}</p></blockquote>)}{assessment.missingEvidence?.length > 0 && <p>Missing evidence: {Array.isArray(assessment.missingEvidence) ? assessment.missingEvidence.join(' · ') : assessment.missingEvidence}</p>}<p>No source policy was changed.</p></div>}
  </div>
}
