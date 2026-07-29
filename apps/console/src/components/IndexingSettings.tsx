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

export function IndexingSettings() {
  const [payload, setPayload] = useState<SettingsPayload | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [rows, setRows] = useState<Record<string, RowState>>({})

  const apply = (data: SettingsPayload) => {
    setPayload(data)
    setRows(Object.fromEntries(
      data.catalog.map((d) => [d.key, { value: format(data.settings[d.key] ?? d.default), error: null, saving: false }]),
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
      setRow(def.key, { error: `Enter a value between ${def.min.toLocaleString()} and ${def.max.toLocaleString()}.` })
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
          return (
            <div key={def.key} className="cc-settings-row">
              <div>
                <strong>
                  <label htmlFor={`cc-set-${def.key}`}>{def.label}</label>
                </strong>
                <span>{def.help}</span>
                {row?.error && <p className="cc-settings-rowerr">{row.error}</p>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {!isDefault && (
                  <button
                    type="button"
                    className="cc-settings-reset"
                    onClick={() => void commit(def, null)}
                    disabled={row?.saving}
                    title={`Reset to the default (${def.default.toLocaleString()})`}
                  >Reset</button>
                )}
                <input
                  id={`cc-set-${def.key}`}
                  className="cc-settings-number"
                  type="number"
                  inputMode="numeric"
                  min={def.min}
                  max={def.max}
                  value={row?.value ?? ''}
                  disabled={row?.saving}
                  onChange={(e) => setRow(def.key, { value: e.target.value, error: null })}
                  onBlur={() => save(def)}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                />
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
