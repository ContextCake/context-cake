// Sources view: manage the layers feeding the cascade — rename, re-level,
// sync, and remove ride the engine's source API (PATCH/DELETE /api/sources,
// POST /api/sources/sync). Name and level are the only mutable fields; a
// wrong path, repo, or command is fixed by remove + re-add, and the UI says
// so instead of pretending otherwise. Errors render verbatim — including the
// engine's pack-invariant messages — never paraphrased into vagueness.
// Demo mode shows the same rows read-only.
import { useState } from 'react'
import { C, css, MONO } from '../theme'
import { apiFetch } from '../api'
import { LayerChip } from '../components/LayerChip'
import { LevelStepper } from '../components/SetupWizard'
import { useStore } from '../store'
import type { Source } from '../data'

// Sync of a clone-backed source runs `git pull` server-side (bounded at 120s
// there) — same headroom as the wizard's mutations.
const MUTATION_TIMEOUT_MS = 150_000

async function callApi(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await apiFetch(path, { ...init, signal: AbortSignal.timeout(MUTATION_TIMEOUT_MS) })
  const data = await res.json().catch(() => ({}) as { error?: string })
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Server returned ${res.status}`)
  return data as Record<string, unknown>
}

const statusColor = (s: Source['status']) =>
  s === 'error' ? C.amberStrokeE : s === 'degraded' ? C.amberStroke : s === 'serving' ? C.tealStrokeE : s === 'empty' ? C.lineStrong : C.blueStroke

/** ISO timestamps read better as local time; unparseable values pass through. */
function fmtTime(iso: string): string {
  const t = new Date(iso)
  return Number.isNaN(t.getTime()) ? iso : t.toLocaleString()
}

/** Sync applies to REST github layers and to clone-backed layers (origin set). */
function canSync(s: Source): boolean {
  return s.sourceKind === 'github' || Boolean(s.origin)
}

function btnSmallGhost(): React.CSSProperties {
  return css(`padding:6px 11px; background:transparent; border:1px solid ${C.line}; border-radius:8px; cursor:pointer; font:inherit; font-weight:600; font-size:11.5px; color:${C.caption};`)
}
function btnSmallDanger(): React.CSSProperties {
  return css(`padding:6px 11px; background:${C.amberFill}; border:1px solid ${C.amberStrokeE}; border-radius:8px; cursor:pointer; font:inherit; font-weight:600; font-size:11.5px; color:${C.amberText};`)
}
function btnSmallPrimary(): React.CSSProperties {
  return css(`padding:6px 11px; background:${C.tealFill}; border:1px solid ${C.tealStroke}; border-radius:8px; cursor:pointer; font:inherit; font-weight:600; font-size:11.5px; color:${C.tealText};`)
}
function btnSmallDisabled(): React.CSSProperties {
  return css(`padding:6px 11px; background:${C.neutralFill}; border:1px solid ${C.line}; border-radius:8px; cursor:not-allowed; font:inherit; font-weight:600; font-size:11.5px; color:${C.faint};`)
}

function LiveMarker() {
  return (
    <span
      title="This layer captures and shares team context. Removing or renaming it disables team capture for this machine."
      style={css(`display:inline-flex; align-items:center; gap:5px; font-family:${MONO}; font-size:9.5px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; padding:2px 8px; border-radius:999px; background:${C.amberFill}; color:${C.amberText}; border:1px solid ${C.amberStroke};`)}
    >
      <span aria-hidden="true" style={css(`width:5px; height:5px; border-radius:999px; background:${C.amberStrokeE};`)} />
      live team layer
    </span>
  )
}

function LiveWarning({ verb }: { verb: 'Removing' | 'Renaming' }) {
  return (
    <div role="alert" style={css(`padding:9px 11px; border-radius:8px; background:${C.amberFill}; border:1px solid ${C.amberStroke}; font-size:11.5px; line-height:1.5; color:${C.amberText};`)}>
      This is the live team layer. {verb} it disables team capture for this machine
      {verb === 'Renaming' ? ' — staged captures fail closed when the binding changes.' : '.'}
    </div>
  )
}

function CredentialWarning({ source }: { source: Source }) {
  if (source.authState !== 'missing-token' && source.authState !== 'host-mismatch') return null
  const alias = source.authAlias ?? 'unknown'
  const isEnv = alias.startsWith('env:')
  const label = isEnv ? `Environment credential ${alias.slice(4)}` : `Credential keychain:${alias}`
  const text = source.authState === 'host-mismatch'
    ? `${label} was withheld because it is bound to a different GitHub host.`
    : isEnv
      ? `${label} is not set in the engine environment.`
      : `${label} is not connected. Add it in Settings → Connections.`
  return (
    <div role="alert" style={css(`padding:8px 10px; border-radius:8px; background:${C.amberFill}; border:1px solid ${C.amberStroke}; font-size:11.5px; line-height:1.5; color:${C.amberText}; overflow-wrap:anywhere;`)}>
      {text}
    </div>
  )
}

type Panel = { name: string; kind: 'edit' | 'remove' } | null

export function Sources({ onAddSource }: { onAddSource?: () => void }) {
  const { mode, sources, reload } = useStore()
  const live = mode === 'live'

  const [panel, setPanel] = useState<Panel>(null)
  const [editName, setEditName] = useState('')
  const [editLevel, setEditLevel] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ name: string; text: string } | null>(null)
  const [syncErr, setSyncErr] = useState<{ name: string; text: string } | null>(null)

  const ordered = [...sources].sort((a, b) => b.level - a.level || a.name.localeCompare(b.name))

  const openEdit = (s: Source) => {
    setPanel({ name: s.name, kind: 'edit' })
    setEditName(s.name)
    setEditLevel(s.level)
    setErr(null)
  }
  const openRemove = (s: Source) => { setPanel({ name: s.name, kind: 'remove' }); setErr(null) }
  const closePanel = () => { setPanel(null); setErr(null) }

  const saveEdit = async (s: Source) => {
    const newName = editName.trim()
    if (!newName) { setErr('Give this source a short name.'); return }
    const body: Record<string, unknown> = { name: s.name }
    if (newName !== s.name) body.newName = newName
    if (editLevel !== s.level) body.level = editLevel
    if (body.newName === undefined && body.level === undefined) { closePanel(); return }
    setBusy(true)
    setErr(null)
    try {
      await callApi('/api/sources', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      closePanel()
      reload()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const confirmRemove = async (s: Source) => {
    setBusy(true)
    setErr(null)
    try {
      await callApi(`/api/sources?name=${encodeURIComponent(s.name)}`, { method: 'DELETE' })
      closePanel()
      reload()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const syncNow = async (s: Source) => {
    setSyncing(s.name)
    setNotice(null)
    setSyncErr(null)
    try {
      const out = await callApi(`/api/sources/sync?name=${encodeURIComponent(s.name)}`, { method: 'POST' })
      const concepts = typeof out.concepts === 'number' ? ` · ${out.concepts} concept${out.concepts === 1 ? '' : 's'}` : ''
      setNotice({ name: s.name, text: `Synced${concepts}` })
      reload()
    } catch (e) {
      setSyncErr({ name: s.name, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setSyncing(null)
    }
  }

  return (
    <div style={css('display:flex; flex-direction:column; gap:14px; max-width:860px;')}>
      <div style={css('display:flex; align-items:center; justify-content:space-between; gap:12px;')}>
        <p style={css(`margin:0; font-size:12.5px; line-height:1.5; color:${C.caption};`)}>
          {live
            ? 'Each source is one layer of the cascade. Name and level can change here; to fix a path, repo, or command, remove the source and add it again.'
            : 'Demo data — source management needs the live engine. Open the console from the ContextCake app, or run npm run console:live.'}
        </p>
        {live && onAddSource && (
          <button type="button" className="cc-h-tealfill2" style={{ ...btnSmallPrimary(), flex: '0 0 auto' }} onClick={onAddSource}>
            Add source
          </button>
        )}
      </div>

      {ordered.length === 0 && (
        <div style={css(`display:grid; place-items:center; min-height:220px; background:${C.surface}; border:1px dashed ${C.lineStrong}; border-radius:13px; padding:32px; text-align:center;`)}>
          <div style={css('max-width:380px;')}>
            <div style={css(`font-weight:600; font-size:14.5px; color:${C.ink}; margin-bottom:8px;`)}>No sources yet</div>
            <p style={css(`margin:0; font-size:12.5px; color:${C.caption}; line-height:1.5;`)}>Nothing is feeding the cascade. Add a folder, repository, or MCP server to get started.</p>
          </div>
        </div>
      )}

      {ordered.map((s) => {
        const isOpen = panel?.name === s.name
        const editing = isOpen && panel?.kind === 'edit'
        const removing = isOpen && panel?.kind === 'remove'
        return (
          <section
            key={s.name}
            aria-label={`Source ${s.name}`}
            style={css(`background:${C.surface}; border:1px solid ${C.line}; border-radius:12px; padding:14px 16px; display:flex; flex-direction:column; gap:10px;`)}
          >
            <div style={css('display:flex; align-items:center; gap:10px; flex-wrap:wrap;')}>
              <span style={css(`font-family:${MONO}; font-size:13.5px; font-weight:600; color:${C.ink}; overflow-wrap:anywhere;`)}>{s.name}</span>
              <LayerChip id={s.layer} />
              {s.live && <LiveMarker />}
              <span style={css(`font-size:11px; color:${C.faint}; font-family:${MONO};`)}>level {s.level} · {s.sourceKind}</span>
              <div style={css('display:flex; align-items:center; gap:6px; margin-left:auto;')}>
                <span aria-hidden="true" style={css(`width:7px; height:7px; border-radius:999px; background:${statusColor(s.status)};`)} />
                <span style={css(`font-size:11.5px; color:${C.caption};`)}>{s.status}</span>
              </div>
            </div>

            <div style={css(`display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; font-size:11.5px; color:${C.caption};`)}>
              <span>{s.conceptCount} concept{s.conceptCount === 1 ? '' : 's'}</span>
              {s.lastSuccessAt && <span title={s.lastSuccessAt}>last success {fmtTime(s.lastSuccessAt)}</span>}
              {s.lastErrorAt && <span title={s.lastErrorAt} style={css(`color:${C.amberText};`)}>last error {fmtTime(s.lastErrorAt)}</span>}
            </div>

            {s.error && (
              <div role="alert" style={css(`padding:8px 10px; border-radius:8px; background:${C.amberFill}; border:1px solid ${C.amberStroke}; font-family:${MONO}; font-size:11px; line-height:1.5; color:${C.amberText}; overflow-wrap:anywhere;`)}>
                {s.error}
              </div>
            )}

            <CredentialWarning source={s} />

            {notice?.name === s.name && (
              <div role="status" style={css(`padding:8px 10px; border-radius:8px; background:${C.tealFill}; border:1px solid ${C.tealStroke}; font-size:11.5px; color:${C.tealText};`)}>
                {notice.text}
              </div>
            )}
            {syncErr?.name === s.name && (
              <div role="alert" style={css(`padding:8px 10px; border-radius:8px; background:${C.amberFill}; border:1px solid ${C.amberStrokeE}; font-family:${MONO}; font-size:11px; line-height:1.5; color:${C.amberText}; overflow-wrap:anywhere;`)}>
                {syncErr.text}
              </div>
            )}

            {live && !isOpen && (
              <div style={css('display:flex; gap:8px; flex-wrap:wrap;')}>
                {canSync(s) && (
                  <button
                    type="button"
                    className="cc-h-bd-strong"
                    aria-label={`Sync ${s.name} now`}
                    disabled={syncing === s.name}
                    style={syncing === s.name ? btnSmallDisabled() : btnSmallGhost()}
                    onClick={() => void syncNow(s)}
                  >{syncing === s.name ? 'Syncing…' : 'Sync now'}</button>
                )}
                <button type="button" className="cc-h-bd-strong" aria-label={`Rename or re-level ${s.name}`} style={btnSmallGhost()} onClick={() => openEdit(s)}>Rename / level</button>
                <button type="button" className="cc-h-bd-amber2" aria-label={`Remove ${s.name}`} style={btnSmallGhost()} onClick={() => openRemove(s)}>Remove</button>
              </div>
            )}

            {editing && (
              <div style={css(`display:flex; flex-direction:column; gap:10px; padding:12px; border-radius:10px; background:${C.raised}; border:1px solid ${C.line};`)}>
                <div style={css('display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; align-items:start;')}>
                  <div>
                    <label htmlFor={`src-edit-name`} style={css(`display:block; font-size:12px; font-weight:600; color:${C.body}; margin-bottom:5px;`)}>Source name</label>
                    <input
                      id="src-edit-name"
                      style={css(`width:100%; box-sizing:border-box; padding:9px 11px; border-radius:8px; border:1px solid ${C.line}; background:${C.surface}; color:${C.ink}; font:inherit; font-size:13px;`)}
                      value={editName}
                      onChange={(e) => { setEditName(e.target.value); setErr(null) }}
                      autoComplete="off"
                    />
                  </div>
                  <LevelStepper id="src-edit-level" value={editLevel} onChange={setEditLevel} />
                </div>
                <p style={css(`margin:0; font-size:11.5px; line-height:1.5; color:${C.caption};`)}>
                  Name and level are all that can change here. To point at a different path, repo, or command, remove this source and add it again.
                </p>
                {s.live && <LiveWarning verb="Renaming" />}
                {err && <p role="alert" style={css(`margin:0; font-size:12px; color:${C.amberText}; overflow-wrap:anywhere;`)}>{err}</p>}
                <div style={css('display:flex; justify-content:flex-end; gap:8px;')}>
                  <button type="button" style={btnSmallGhost()} onClick={closePanel}>Cancel</button>
                  <button type="button" disabled={busy} style={busy ? btnSmallDisabled() : btnSmallPrimary()} onClick={() => void saveEdit(s)}>
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            )}

            {removing && (
              <div style={css(`display:flex; flex-direction:column; gap:10px; padding:12px; border-radius:10px; background:${C.raised}; border:1px solid ${C.amberStroke};`)}>
                <p style={css(`margin:0; font-size:12.5px; line-height:1.5; color:${C.body};`)}>
                  Remove <strong style={css(`font-family:${MONO};`)}>{s.name}</strong> from the cascade? Your files stay where they are — only the cascade entry is removed.
                </p>
                {s.live && <LiveWarning verb="Removing" />}
                {err && <p role="alert" style={css(`margin:0; font-size:12px; color:${C.amberText}; overflow-wrap:anywhere;`)}>{err}</p>}
                <div style={css('display:flex; justify-content:flex-end; gap:8px;')}>
                  <button type="button" style={btnSmallGhost()} onClick={closePanel}>Cancel</button>
                  <button type="button" disabled={busy} style={busy ? btnSmallDisabled() : btnSmallDanger()} onClick={() => void confirmRemove(s)}>
                    {busy ? 'Removing…' : 'Remove source'}
                  </button>
                </div>
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
