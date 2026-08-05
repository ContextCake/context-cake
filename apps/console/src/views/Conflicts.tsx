import { useEffect, useMemo, useState } from 'react'
import { C, css, lc, MONO } from '../theme'
import { layerLevel, layerName } from '../data'
import type { Conflict, Contribution } from '../data'
import { LayerChip } from '../components/LayerChip'
import { Markdown } from '../components/Markdown'
import { useStore } from '../store'

function WandIcon() {
  return (
    <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m15 4 5 5L9 20l-5-5L15 4Z" /><path d="m14 5 5 5" />
      <path d="M5 3v3M3.5 4.5h3M19 16v4M17 18h4" />
    </svg>
  )
}

function formatDate(value: string) {
  if (!value) return 'date not recorded'
  const parsed = new Date(value.includes('T') ? value : `${value}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: value.includes('T') ? 'short' : undefined }).format(parsed)
}

function choiceName(choice: Contribution) {
  const familiar = layerName(choice.layer)
  return choice.sourceLayer === choice.layer ? familiar : `${familiar} · ${choice.sourceLayer}`
}

function Choice({
  choice,
  conflict,
  checked,
  disabled,
  onChange,
}: {
  choice: Contribution
  conflict: Conflict
  checked: boolean
  disabled: boolean
  onChange: () => void
}) {
  const isEffective = choice.sourceLayer === conflict.contributions[0]?.sourceLayer && conflict.status === 'open'
  const col = lc(choice.layer)
  return (
    <label className="cc-conflict-choice" data-selected={checked ? 'true' : 'false'} data-disabled={disabled ? 'true' : 'false'}>
      <input
        type="radio"
        name={`choice-${conflict.id}`}
        value={choice.sourceLayer}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <div className="cc-conflict-choice-body">
        <div className="cc-conflict-choice-head">
          <span style={css('display:flex; align-items:center; gap:8px; min-width:0;')}>
            <span style={css(`display:grid; place-items:center; width:24px; height:24px; flex:0 0 auto; border-radius:999px; background:${C.raised}; border:2px solid ${col.strokeE}; color:${col.text}; font-family:${MONO}; font-weight:650; font-size:11px;`)}>{layerLevel(choice.layer)}</span>
            <span style={css(`font-weight:650; font-size:13.5px; color:${col.text}; overflow:hidden; text-overflow:ellipsis;`)}>{choiceName(choice)}</span>
          </span>
          <span style={css('display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:flex-end;')}>
            {isEffective && <span className="cc-conflict-tag" data-tone="effective">Used now</span>}
            {choice.fresherDissent && <span className="cc-conflict-tag" data-tone="newer">Newer</span>}
          </span>
        </div>
        <Markdown className="cc-conflict-answer" source={choice.value} />
        <span className="cc-conflict-date">Updated {formatDate(choice.updated)}</span>
      </div>
    </label>
  )
}

export function Conflicts() {
  const {
    conflicts, selConflict, setSelConflict, resolveConflict, resolveSafeConflicts,
    resolvingConflict, resolutionError,
  } = useStore()
  const selConf = conflicts.find((conflict) => conflict.id === selConflict) ?? conflicts[0] ?? null
  const [selectedLayer, setSelectedLayer] = useState('')
  const [changing, setChanging] = useState(false)

  const open = useMemo(() => conflicts.filter((conflict) => conflict.status === 'open'), [conflicts])
  const safe = useMemo(() => open.filter((conflict) => conflict.safe), [open])
  const needsJudgment = open.length - safe.length

  useEffect(() => {
    setChanging(false)
    if (!selConf) { setSelectedLayer(''); return }
    const latest = selConf.history[selConf.history.length - 1]
    setSelectedLayer(latest?.chosen.layer ?? '')
  }, [selConf?.id, selConf?.history.length])

  if (conflicts.length === 0) {
    return (
      <div className="cc-conflict-empty">
        <div style={css('max-width:400px;')}>
          <div style={css('font-weight:650; font-size:15px; color:var(--cc-ink); margin-bottom:8px;')}>No conflicts</div>
          <p style={css('margin:0; font-size:13px; color:var(--cc-body); line-height:1.55;')}>Every section agrees across the cascade. New disagreements will appear here with their source and date.</p>
        </div>
      </div>
    )
  }

  const busy = resolvingConflict !== null
  const currentChoice = selConf?.contributions.find((choice) => choice.sourceLayer === selectedLayer)
  const applyChoice = async () => {
    if (!selConf || !currentChoice) return
    try { await resolveConflict(selConf.id, currentChoice.sourceLayer, 'manual') } catch { /* store renders the error */ }
  }

  const applySafe = async () => {
    if (!selConf) return
    const current = selConf.contributions[0]
    try { await resolveConflict(selConf.id, current.sourceLayer, 'automatic') } catch { /* store renders the error */ }
  }

  return (
    <div className="cc-conflicts">
      <div className="cc-conflict-summary">
        <div>
          <h2>Resolve conflicts</h2>
          <p>
            {needsJudgment > 0 ? `${needsJudgment} need${needsJudgment === 1 ? 's' : ''} your judgment.` : 'Nothing needs your judgment.'}
            {' '}{safe.length > 0 ? `${safe.length} ${safe.length === 1 ? 'is' : 'are'} safe to resolve.` : ''}
          </p>
        </div>
        {safe.length > 0 && (
          <button type="button" className="cc-conflict-wand" disabled={busy} onClick={() => void resolveSafeConflicts()}>
            <WandIcon />
            <span>{resolvingConflict === 'safe-batch' ? 'Resolving…' : `Resolve ${safe.length} safe ${safe.length === 1 ? 'conflict' : 'conflicts'}`}</span>
          </button>
        )}
      </div>

      {resolutionError && (
        <div className="cc-conflict-error" role="alert">
          <strong>{resolutionError.partial ? 'Some safe conflicts were resolved.' : 'Nothing was changed.'}</strong> {resolutionError.message}
        </div>
      )}

      <div className="cc-conflict-layout">
        <div className="cc-conflict-list" aria-label="Conflicts">
          {conflicts.map((conflict) => {
            const selected = conflict.id === selConf?.id
            const latest = conflict.history[conflict.history.length - 1]
            return (
              <button
                type="button"
                key={conflict.id}
                className="cc-conflict-row"
                data-selected={selected ? 'true' : 'false'}
                data-status={conflict.status}
                onClick={() => setSelConflict(conflict.id)}
              >
                <span className="cc-conflict-row-top">
                  <code>{conflict.concept}</code>
                  <span className="cc-conflict-row-status">
                    {conflict.status === 'resolved' ? 'Resolved' : conflict.safe ? 'Safe' : 'Needs you'}
                  </span>
                </span>
                <span className="cc-conflict-row-title">{conflict.section}</span>
                <span className="cc-conflict-row-foot">
                  <span>{latest ? `${latest.method === 'automatic' ? 'Auto' : 'Chosen'} · ${formatDate(latest.decidedAt)}` : `${conflict.contributions.length} answers`}</span>
                  <span style={css('display:flex; gap:4px;')}>
                    {conflict.contributions.map((choice) => <LayerChip key={choice.sourceLayer} id={choice.layer} />)}
                  </span>
                </span>
              </button>
            )
          })}
        </div>

        {selConf && (
          <section
            className="cc-conflict-detail"
            data-mode={selConf.status === 'resolved' && !changing ? 'history' : 'decision'}
            aria-labelledby="cc-conflict-question"
          >
            <div className="cc-conflict-path">
              <code>{selConf.concept}</code>
              <span>§ {selConf.section}</span>
            </div>

            {selConf.status === 'resolved' && !changing ? (
              <Resolved conflict={selConf} onChange={() => setChanging(true)} disabled={busy} />
            ) : (
              <>
                <h2 id="cc-conflict-question">Which answer should ContextCake use?</h2>
                <p className="cc-conflict-help">Choose the answer that is true here. ContextCake will update the contributing local files and save the original answers in History.</p>

                {selConf.safe && selConf.status === 'open' && (
                  <div className="cc-conflict-safe">
                    <span className="cc-conflict-safe-icon"><WandIcon /></span>
                    <span>
                      <strong>Safe to resolve.</strong>
                      <span>The answers use the same words in the same order. ContextCake can keep the answer already in use.</span>
                    </span>
                    <button type="button" disabled={busy} onClick={() => void applySafe()}>
                      {resolvingConflict === selConf.id ? 'Resolving…' : 'Resolve safely'}
                    </button>
                  </div>
                )}

                <fieldset className="cc-conflict-choices" disabled={busy}>
                  <legend className="cc-sr-only">Answers</legend>
                  {selConf.contributions
                    .slice()
                    .sort((a, b) => layerLevel(b.layer) - layerLevel(a.layer))
                    .map((choice) => (
                      <Choice
                        key={choice.sourceLayer}
                        choice={choice}
                        conflict={selConf}
                        checked={selectedLayer === choice.sourceLayer}
                        disabled={busy}
                        onChange={() => setSelectedLayer(choice.sourceLayer)}
                      />
                    ))}
                </fieldset>

                <div className="cc-conflict-actions">
                  <button type="button" className="cc-conflict-primary" disabled={!currentChoice || busy} onClick={() => void applyChoice()}>
                    {resolvingConflict === selConf.id
                      ? 'Applying…'
                      : currentChoice
                        ? `Use the ${layerName(currentChoice.layer)} answer`
                        : 'Choose an answer'}
                  </button>
                  {changing && <button type="button" className="cc-conflict-secondary" disabled={busy} onClick={() => setChanging(false)}>Cancel</button>}
                  {!changing && <span className="cc-conflict-leave">You can leave this open.</span>}
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  )
}

function Resolved({ conflict, onChange, disabled }: { conflict: Conflict; onChange: () => void; disabled: boolean }) {
  const latest = conflict.history[conflict.history.length - 1]
  const chosen = conflict.contributions.find((choice) => choice.sourceLayer === latest.chosen.layer)
  return (
    <>
      <div className="cc-conflict-resolved-head">
        <span className="cc-conflict-check" aria-hidden="true">✓</span>
        <div>
          <h2>{latest.method === 'automatic' ? 'Resolved automatically' : `${layerName(chosen?.layer ?? conflict.winner)} answer chosen`}</h2>
          <p>{latest.reason}</p>
        </div>
      </div>

      <div className="cc-conflict-chosen">
        <span>Answer now in use</span>
        <Markdown className="cc-conflict-chosen-answer" source={latest.chosen.content} />
        <small>{latest.chosen.layer} · {formatDate(latest.decidedAt)}</small>
      </div>

      <div className="cc-conflict-history">
        <div className="cc-conflict-history-head">
          <div>
            <h3>History</h3>
            <p>Original answers stay here even after the source files agree.</p>
          </div>
          <button type="button" className="cc-conflict-secondary" disabled={disabled} onClick={onChange}>Change decision</button>
        </div>
        <ol>
          {conflict.history.slice().reverse().map((record) => {
            const recordedChoice = conflict.contributions.find((choice) => choice.sourceLayer === record.chosen.layer)
            return (
              <li key={record.id}>
                <span className="cc-conflict-history-dot" aria-hidden="true" />
                <span>
                  <strong>{record.method === 'automatic' ? 'Kept the current answer' : `Chose ${recordedChoice ? choiceName(recordedChoice) : record.chosen.layer}`}</strong>
                  <small>{formatDate(record.decidedAt)} · {record.contributions.length} original answers saved</small>
                </span>
              </li>
            )
          })}
        </ol>
      </div>
    </>
  )
}
