// Governed learning: the rules the engine mined from repeated decisions, the
// suggestions waiting for approval, and the team-promotion preview. Moved
// out of the view root unchanged in behavior; the only additions are how a
// `*` match (any type / any key) and a `rewrite_link` action read.
import { useState } from 'react'
import type { DiscrepancyRule } from '../../types'
import { useStoreData } from '../../store'
import { KIND_LABEL } from './labels'

export function actionLabel(action: DiscrepancyRule['action']): string {
  if (action.type === 'prefer_source') return `Prefer ${action.source}`
  if (action.type === 'rewrite_link') return `Rewrite → ${action.newTarget}`
  return `Acknowledge as ${action.reasonCode.replace(/_/g, ' ')}`
}

/** "Broken link · any type · any key · personal → decisions/old" — the scope a rule matches, `*` read as "any". */
export function matchLabel(match: DiscrepancyRule['match']): string {
  const any = (value: string, noun: string) => (value === '*' ? `any ${noun}` : value)
  return [
    KIND_LABEL[match.kind] ?? match.kind,
    any(match.conceptType, 'type'),
    any(match.key, 'key'),
    match.sources.join(' + '),
    ...(match.target ? [`→ ${match.target}`] : []),
  ].join(' · ')
}

export function Rules() {
  const store = useStoreData()
  const { mode, approveRuleSuggestion, updateDiscrepancyRule, promoteDiscrepancyRule } = store
  const discrepancyRules = store.discrepancyRules ?? []
  const discrepancyRuleSuggestions = store.discrepancyRuleSuggestions ?? []
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null)
  return (
    <section className="cc-rules" aria-labelledby="cc-rules-heading">
      <div><h3 id="cc-rules-heading">Governed learning</h3><p>Repeated manual decisions can suggest structural rules. Confidence never grants permission.</p></div>
      {discrepancyRuleSuggestions.map((suggestion) => (
        <article key={suggestion.id}>
          <strong>Suggested from {suggestion.evidenceCount} decisions{suggestion.generalized ? ' across several sections' : ''}</strong>
          <span>{actionLabel(suggestion.action)} · {matchLabel(suggestion.match)}</span>
          <details><summary>Inspect supporting decisions</summary><ul>{suggestion.evidenceDecisionIds.map((id) => <li key={id}><code>{id}</code></li>)}</ul></details>
          <button type="button" disabled={mode === 'demo'} onClick={() => void approveRuleSuggestion(suggestion.id)}>Approve as recommendation</button>
        </article>
      ))}
      {discrepancyRules.map((rule) => (
        <article key={rule.id}>
          <strong>{actionLabel(rule.action)}</strong>
          <span>{rule.scope} · {rule.mode} · {matchLabel(rule.match)}</span>
          <div>
            <button type="button" disabled={mode === 'demo'} onClick={() => void updateDiscrepancyRule(rule.id, { enabled: !rule.enabled })}>{rule.enabled ? 'Disable' : 'Enable'}</button>
            <button type="button" disabled={mode === 'demo' || !rule.enabled} onClick={() => void updateDiscrepancyRule(rule.id, { mode: rule.mode === 'automatic' ? 'recommend' : 'automatic' })}>{rule.mode === 'automatic' ? 'Return to recommend' : 'Enable automatic use'}</button>
            {rule.scope === 'local' && <button type="button" disabled={mode === 'demo'} onClick={async () => setPreview(await promoteDiscrepancyRule(rule.id, false))}>Preview team promotion</button>}
          </div>
        </article>
      ))}
      {preview?.requiresConfirmation === true && <div className="cc-rule-preview" role="dialog" aria-label="Team rule promotion preview"><h4>Promote as a team recommendation?</h4><pre>{JSON.stringify(preview.preview, null, 2)}</pre><button type="button" onClick={() => void promoteDiscrepancyRule(String((preview.preview as { id?: string }).id), true).then(() => setPreview(null))}>Confirm promotion</button><button type="button" onClick={() => setPreview(null)}>Cancel</button></div>}
      {!discrepancyRules.length && !discrepancyRuleSuggestions.length && <p className="cc-muted">No rules or suggestions yet. Suggestions appear after three consistent manual decisions.</p>}
    </section>
  )
}
