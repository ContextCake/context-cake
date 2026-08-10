// The Indexing pane of Settings: the limits that decide how much of a folder
// ContextCake will read. These used to be environment variables, which is not
// something anyone should have to edit to index a bigger notes folder.
//
// Values are stored in the manifest and win over the environment, so what this
// screen shows is what the engine actually uses.
import { useEffect, useState } from 'react'
import { apiFetch } from '../api'
import type { SettingDef, SettingsPayload } from '../types'

interface RowState {
  value: string
  error: string | null
  saving: boolean
}

function format(n: number): string {
  return String(n)
}

/** Whether a setting's stored unit is milliseconds — its key names that, e.g. `sourceBudgetMs`. */
function isMillisecondSetting(key: string): boolean {
  return key.endsWith('Ms')
}

type MsUnit = 'min' | 'hr'
const MS_PER_UNIT: Record<MsUnit, number> = { min: 60_000, hr: 3_600_000 }

/** Whichever unit divides `ms` evenly and reads smallest — minutes below an
 *  hour, hours at or above one, falling back to minutes for anything under a
 *  minute (sub-minute budgets are a headless/test concern, not a UI one). */
function unitFor(ms: number): MsUnit {
  return ms >= MS_PER_UNIT.hr && ms % MS_PER_UNIT.hr === 0 ? 'hr' : 'min'
}

/**
 * "120000 ms = 2 min" — the human-scale reading beside the raw number. The
 * engine's catalog (settings.mjs) supplies `label`/`help` and never a unit or
 * a friendlier scale, so that reading is computed here rather than asking the
 * engine to speak console-specific UI copy.
 */
function humanizeMs(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null
  const round = (n: number) => Math.round(n * 10) / 10
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${round(ms / 1000)} sec`
  if (ms < 3_600_000) return `${round(ms / 60_000)} min`
  return `${round(ms / 3_600_000)} hr`
}

export function IndexingSettings({ onChanged }: { onChanged?: () => void }) {
  const [payload, setPayload] = useState<SettingsPayload | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [rows, setRows] = useState<Record<string, RowState>>({})
  // Ms-suffixed settings are edited in minutes/hours, not raw ms — this holds
  // the unit each such field is currently displayed in, separate from RowState
  // (which stays in the setting's real, ms-denominated units so `commit()`
  // and the API stay unchanged).
  const [units, setUnits] = useState<Record<string, MsUnit>>({})

  const apply = (data: SettingsPayload) => {
    setPayload(data)
    setRows(Object.fromEntries(
      data.catalog.map((d) => [d.key, { value: format(data.settings[d.key] ?? d.default), error: null, saving: false }]),
    ))
    setUnits((prev) => Object.fromEntries(
      data.catalog.filter((d) => isMillisecondSetting(d.key)).map((d) => [d.key, prev[d.key] ?? unitFor(data.settings[d.key] ?? d.default)]),
    ))
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await apiFetch('/api/settings', { headers: { accept: 'application/json' } })
        if (!res.ok) throw new Error(`Server returned ${res.status}`)
        const data = (await res.json()) as SettingsPayload
        if (!cancelled) apply(data)
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [])

  const setRow = (key: string, patch: Partial<RowState>) => {
    setRows((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }))
  }

  /** Format an ms bound (def.min/def.max) in whichever unit the field is
   *  currently showing, for a validation message that matches what the user typed. */
  const formatBound = (ms: number, unit: MsUnit): string => {
    const n = ms / MS_PER_UNIT[unit]
    return `${Number.isInteger(n) ? n : Math.round(n * 100) / 100} ${unit === 'hr' ? 'hr' : 'min'}`
  }

  const commit = async (def: SettingDef, raw: number | null) => {
    setRow(def.key, { saving: true, error: null })
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [def.key]: raw }),
      })
      const data = await res.json().catch(() => ({}) as { error?: string })
      if (!res.ok) throw new Error((data as { error?: string }).error ?? `Server returned ${res.status}`)
      apply(data as SettingsPayload)
      onChanged?.()
    } catch (e) {
      setRow(def.key, { error: e instanceof Error ? e.message : String(e), saving: false })
    }
  }

  /** Save on blur — the value is only sent once the user is done typing. */
  const save = (def: SettingDef) => {
    const row = rows[def.key]
    if (!row) return
    const value = Number(row.value)
    if (!Number.isFinite(value)) {
      setRow(def.key, { error: 'Enter a number.' })
      return
    }
    if (value < def.min || value > def.max) {
      const unit = units[def.key]
      const range = unit ? `${formatBound(def.min, unit)} and ${formatBound(def.max, unit)}` : `${def.min.toLocaleString()} and ${def.max.toLocaleString()}`
      setRow(def.key, { error: `Enter a value between ${range}.` })
      return
    }
    if (value === (payload?.settings[def.key] ?? def.default)) return // no change
    void commit(def, value)
  }

  if (loadError) {
    return (
      <div className="cc-settings-empty">
        Indexing settings need a running ContextCake engine. ({loadError})
      </div>
    )
  }
  if (!payload) {
    return <div className="cc-settings-empty">Loading indexing settings…</div>
  }

  return (
    <section className="cc-settings-section" aria-labelledby="cc-settings-indexing">
      <h2 id="cc-settings-indexing">Limits</h2>
      <div className="cc-settings-group">
        {payload.catalog.map((def) => {
          const row = rows[def.key]
          const isDefault = payload.stored[def.key] === undefined
          const isMs = isMillisecondSetting(def.key)
          const rowValue = row ? Number(row.value) : NaN
          const humanized = isMs && Number.isFinite(rowValue) ? humanizeMs(rowValue) : null
          const unit = units[def.key] ?? 'min'
          const displayValue = isMs && Number.isFinite(rowValue)
            ? String(Math.round((rowValue / MS_PER_UNIT[unit]) * 100) / 100)
            : (row?.value ?? '')
          return (
            <div key={def.key} className="cc-settings-row">
              <div>
                <strong>
                  <label htmlFor={`cc-set-${def.key}`}>{def.label}</label>
                </strong>
                <span>{def.help}</span>
                {humanized && <p className="cc-settings-hint">{row?.value} ms = {humanized}</p>}
                {row?.error && <p className="cc-settings-rowerr">{row.error}</p>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {!isDefault && (
                  <button
                    type="button"
                    className="cc-settings-reset"
                    onClick={() => void commit(def, null)}
                    disabled={row?.saving}
                    title={`Reset to the default (${isMs ? humanizeMs(def.default) : def.default.toLocaleString()})`}
                  >Reset</button>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    id={`cc-set-${def.key}`}
                    className="cc-settings-number"
                    type="number"
                    inputMode="decimal"
                    min={isMs ? 0 : def.min}
                    max={isMs ? undefined : def.max}
                    value={isMs ? displayValue : (row?.value ?? '')}
                    disabled={row?.saving}
                    onChange={(e) => {
                      if (!isMs) { setRow(def.key, { value: e.target.value, error: null }); return }
                      const n = Number(e.target.value)
                      setRow(def.key, { value: Number.isFinite(n) ? String(n * MS_PER_UNIT[unit]) : e.target.value, error: null })
                    }}
                    onBlur={() => save(def)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                  />
                  {isMs ? (
                    <select
                      id={`cc-set-${def.key}-unit`}
                      className="cc-settings-unit-select"
                      aria-label={`${def.label} unit`}
                      value={unit}
                      disabled={row?.saving}
                      onChange={(e) => setUnits((prev) => ({ ...prev, [def.key]: e.target.value as MsUnit }))}
                    >
                      <option value="min">minutes</option>
                      <option value="hr">hours</option>
                    </select>
                  ) : null}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <p style={{ margin: '12px 2px 0', fontSize: 11.5, lineHeight: 1.5, color: 'var(--cc-caption)' }}>
        Changing a limit re-indexes your sources in the background. ContextCake stays usable while it works.
      </p>
    </section>
  )
}
