// First-run setup wizard — live mode only, shown when the resolved cascade
// has zero sources. Walks the user through writing a manifest via the
// playground server's source API (POST /api/sources). See TASK 4B.
import { useEffect, useRef, useState } from 'react'
import { C, css, MONO } from '../theme'
import { useStore } from '../store'
import type { GraphSummary } from '../types'

type StepId = 'welcome' | 'personal' | 'team' | 'company' | 'review' | 'success'
const STEPS: StepId[] = ['welcome', 'personal', 'team', 'company', 'review', 'success']

interface AddedLayer {
  kind: 'local' | 'github' | 'mcp'
  name: string
  level: number
  detail: string
}

async function postSource(body: Record<string, unknown>): Promise<void> {
  const res = await fetch('/api/sources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  // 409 = the source already exists — e.g. an earlier attempt added it but the
  // follow-up sync failed. Treat as added so retrying the step proceeds to
  // sync instead of wedging on the duplicate name.
  if (res.status === 409) return
  const data = await res.json().catch(() => ({}) as { error?: string })
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Server returned ${res.status}`)
}

async function syncSource(name: string): Promise<void> {
  const res = await fetch(`/api/sources/sync?name=${encodeURIComponent(name)}`, { method: 'POST' })
  const data = await res.json().catch(() => ({}) as { error?: string })
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Server returned ${res.status}`)
}

function StepShell({
  title, subtitle, children, footer, stepIndex,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
  footer?: React.ReactNode
  stepIndex: number
}) {
  return (
    <div style={css('display:flex; flex-direction:column; gap:18px; padding:26px 28px 22px;')}>
      <div style={css('display:flex; align-items:center; gap:6px;')}>
        {STEPS.map((_, i) => (
          <span
            key={i}
            style={css(`height:4px; border-radius:999px; flex:1; background:${i <= stepIndex ? C.tealStroke : C.line};`)}
          />
        ))}
      </div>
      <div>
        <h2 style={css(`margin:0 0 6px; font-size:17px; font-weight:700; color:${C.ink};`)}>{title}</h2>
        <p style={css(`margin:0; font-size:13px; line-height:1.5; color:${C.caption};`)}>{subtitle}</p>
      </div>
      <div style={css('display:flex; flex-direction:column; gap:12px;')}>{children}</div>
      <div style={css('display:flex; align-items:center; justify-content:space-between; margin-top:4px;')}>{footer}</div>
    </div>
  )
}

function fieldLabelStyle(): React.CSSProperties {
  return css(`display:block; font-size:12px; font-weight:600; color:${C.body}; margin-bottom:5px;`)
}
function inputStyle(): React.CSSProperties {
  return css(`width:100%; box-sizing:border-box; padding:9px 11px; border-radius:8px; border:1px solid ${C.line}; background:${C.surface}; color:${C.ink}; font:inherit; font-size:13px;`)
}
function btnPrimary(): React.CSSProperties {
  return css(`padding:9px 16px; background:${C.tealFill}; border:1px solid ${C.tealStroke}; border-radius:9px; cursor:pointer; font:inherit; font-weight:600; font-size:12.5px; color:${C.tealText};`)
}
function btnGhost(): React.CSSProperties {
  return css(`padding:9px 16px; background:transparent; border:1px solid ${C.line}; border-radius:9px; cursor:pointer; font:inherit; font-weight:600; font-size:12.5px; color:${C.caption};`)
}
function btnDisabled(): React.CSSProperties {
  return css(`padding:9px 16px; background:${C.neutralFill}; border:1px solid ${C.line}; border-radius:9px; cursor:not-allowed; font:inherit; font-weight:600; font-size:12.5px; color:${C.faint};`)
}

export function SetupWizard({ onClose }: { onClose: () => void }) {
  const { reload } = useStore()
  const [stepIdx, setStepIdx] = useState(0)
  const step = STEPS[stepIdx]
  const [added, setAdded] = useState<AddedLayer[]>([])

  const [personalPath, setPersonalPath] = useState('')
  const [personalErr, setPersonalErr] = useState<string | null>(null)
  const [personalBusy, setPersonalBusy] = useState(false)

  const [teamKind, setTeamKind] = useState<'local' | 'github'>('local')
  const [teamPath, setTeamPath] = useState('')
  const [teamRepo, setTeamRepo] = useState('')
  const [teamErr, setTeamErr] = useState<string | null>(null)
  const [teamBusy, setTeamBusy] = useState(false)

  const [mcpCommand, setMcpCommand] = useState('')
  const [mcpArgs, setMcpArgs] = useState('')
  const [mcpTrusted, setMcpTrusted] = useState(false)
  const [mcpErr, setMcpErr] = useState<string | null>(null)
  const [mcpBusy, setMcpBusy] = useState(false)

  const [successConcept, setSuccessConcept] = useState<string | null>(null)
  const [successBusy, setSuccessBusy] = useState(false)

  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    dialogRef.current?.focus()
  }, [stepIdx])

  const goNext = () => setStepIdx((i) => Math.min(i + 1, STEPS.length - 1))
  const goBack = () => setStepIdx((i) => Math.max(i - 1, 0))

  const submitPersonal = async () => {
    if (!personalPath.trim()) { setPersonalErr('Provide a folder path.'); return }
    setPersonalBusy(true)
    setPersonalErr(null)
    try {
      await postSource({ kind: 'local', name: 'personal', level: 3, path: personalPath.trim() })
      setAdded((prev) => [...prev, { kind: 'local', name: 'personal', level: 3, detail: personalPath.trim() }])
      goNext()
    } catch (e) {
      setPersonalErr(e instanceof Error ? e.message : String(e))
    } finally {
      setPersonalBusy(false)
    }
  }

  const submitTeam = async () => {
    setTeamBusy(true)
    setTeamErr(null)
    try {
      if (teamKind === 'local') {
        if (!teamPath.trim()) { setTeamErr('Provide a folder path.'); setTeamBusy(false); return }
        await postSource({ kind: 'local', name: 'team', level: 2, path: teamPath.trim() })
        setAdded((prev) => [...prev, { kind: 'local', name: 'team', level: 2, detail: teamPath.trim() }])
      } else {
        if (!teamRepo.trim()) { setTeamErr('Provide a repo as owner/name.'); setTeamBusy(false); return }
        await postSource({ kind: 'github', name: 'team', level: 2, repo: teamRepo.trim() })
        await syncSource('team')
        setAdded((prev) => [...prev, { kind: 'github', name: 'team', level: 2, detail: teamRepo.trim() }])
      }
      goNext()
    } catch (e) {
      setTeamErr(e instanceof Error ? e.message : String(e))
    } finally {
      setTeamBusy(false)
    }
  }

  const skipTeam = () => { setTeamErr(null); goNext() }

  const submitCompany = async () => {
    if (!mcpCommand.trim()) { setMcpErr('Provide a command.'); return }
    if (!mcpTrusted) return
    setMcpBusy(true)
    setMcpErr(null)
    try {
      const args = mcpArgs.trim()
      await postSource({ kind: 'mcp', name: 'company', level: 0, command: mcpCommand.trim(), args })
      setAdded((prev) => [...prev, { kind: 'mcp', name: 'company', level: 0, detail: `${mcpCommand.trim()} ${args}`.trim() }])
      goNext()
    } catch (e) {
      setMcpErr(e instanceof Error ? e.message : String(e))
    } finally {
      setMcpBusy(false)
    }
  }

  const skipCompany = () => { setMcpErr(null); goNext() }

  const finishReview = async () => {
    setSuccessBusy(true)
    reload()
    try {
      const res = await fetch('/api/graph', { headers: { accept: 'application/json' } })
      if (res.ok) {
        const graph = (await res.json()) as GraphSummary
        setSuccessConcept(graph.concepts[0]?.id ?? null)
      }
    } catch {
      setSuccessConcept(null)
    } finally {
      setSuccessBusy(false)
      goNext()
    }
  }

  return (
    <div style={css('position:fixed; inset:0; z-index:60; display:grid; place-items:center; background:var(--cc-scrim);')}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="ContextCake setup"
        tabIndex={-1}
        style={css(`width:min(520px, 92vw); max-height:88vh; overflow-y:auto; background:${C.raised}; border:1px solid ${C.line}; border-radius:16px; box-shadow:0 24px 64px rgba(0,0,0,0.28);`)}
      >
        {step === 'welcome' && (
          <StepShell
            stepIndex={0}
            title="Welcome to ContextCake"
            subtitle="ContextCake stitches your Company, Team, and Personal knowledge into one resolved cascade that agents can read. Let's configure at least a Personal layer to get started."
            footer={(
              <>
                <button type="button" style={btnGhost()} onClick={onClose}>Skip</button>
                <button type="button" style={btnPrimary()} onClick={goNext}>Get started</button>
              </>
            )}
          >
            <div style={css(`padding:12px 14px; border-radius:10px; background:${C.tealFill}; border:1px solid ${C.tealStroke}; font-size:12.5px; color:${C.tealText}; line-height:1.5;`)}>
              You'll configure up to three layers: Personal (required), Team (optional), and Company (optional, MCP).
            </div>
          </StepShell>
        )}

        {step === 'personal' && (
          <StepShell
            stepIndex={1}
            title="Personal layer"
            subtitle="A local folder of OKF markdown that only you read. This is required — it's the minimum to get a working cascade."
          >
            <div>
              <label htmlFor="wiz-personal-path" style={fieldLabelStyle()}>Folder path</label>
              <input
                id="wiz-personal-path"
                style={inputStyle()}
                value={personalPath}
                onChange={(e) => setPersonalPath(e.target.value)}
                placeholder="/Users/you/kb-personal"
                autoComplete="off"
              />
              {personalErr && <p style={css('margin:8px 0 0; font-size:12px; color:var(--cc-amber-text);')}>{personalErr}</p>}
            </div>
            <div style={css('display:flex; align-items:center; justify-content:space-between; margin-top:4px;')}>
              <button type="button" style={btnGhost()} onClick={goBack}>Back</button>
              <div style={css('display:flex; gap:8px;')}>
                <button type="button" style={btnGhost()} onClick={onClose}>Skip</button>
                <button type="button" style={personalBusy ? btnDisabled() : btnPrimary()} disabled={personalBusy} onClick={submitPersonal}>
                  {personalBusy ? 'Adding…' : 'Next'}
                </button>
              </div>
            </div>
          </StepShell>
        )}

        {step === 'team' && (
          <StepShell
            stepIndex={2}
            title="Team layer (optional)"
            subtitle="Shared knowledge for your team — a local folder or a GitHub repo."
          >
            <div style={css('display:flex; gap:6px;')}>
              <button
                type="button"
                style={teamKind === 'local' ? btnPrimary() : btnGhost()}
                onClick={() => setTeamKind('local')}
              >Local path</button>
              <button
                type="button"
                style={teamKind === 'github' ? btnPrimary() : btnGhost()}
                onClick={() => setTeamKind('github')}
              >GitHub repo</button>
            </div>
            {teamKind === 'local' ? (
              <div>
                <label htmlFor="wiz-team-path" style={fieldLabelStyle()}>Folder path</label>
                <input
                  id="wiz-team-path"
                  style={inputStyle()}
                  value={teamPath}
                  onChange={(e) => setTeamPath(e.target.value)}
                  placeholder="/Users/you/kb-shared"
                  autoComplete="off"
                />
              </div>
            ) : (
              <div>
                <label htmlFor="wiz-team-repo" style={fieldLabelStyle()}>Repository</label>
                <input
                  id="wiz-team-repo"
                  style={inputStyle()}
                  value={teamRepo}
                  onChange={(e) => setTeamRepo(e.target.value)}
                  placeholder="owner/name"
                  autoComplete="off"
                />
              </div>
            )}
            {teamErr && <p style={css('margin:0; font-size:12px; color:var(--cc-amber-text);')}>{teamErr}</p>}
            <div style={css('display:flex; align-items:center; justify-content:space-between; margin-top:4px;')}>
              <button type="button" style={btnGhost()} onClick={goBack}>Back</button>
              <div style={css('display:flex; gap:8px;')}>
                <button type="button" style={btnGhost()} onClick={skipTeam}>Skip</button>
                <button type="button" style={teamBusy ? btnDisabled() : btnPrimary()} disabled={teamBusy} onClick={submitTeam}>
                  {teamBusy ? 'Adding…' : 'Next'}
                </button>
              </div>
            </div>
          </StepShell>
        )}

        {step === 'company' && (
          <StepShell
            stepIndex={3}
            title="Company layer (optional, MCP)"
            subtitle="Company knowledge served by a foreign MCP source — a command that runs locally and is translated to OKF at read time."
          >
            <div style={css(`padding:12px 14px; border-radius:10px; background:${C.amberFill}; border:1px solid ${C.amberStroke}; font-size:12.5px; color:${C.amberText}; line-height:1.55;`)}>
              An MCP source runs a command on your machine every time the cascade resolves. Only add servers you trust — a manifest you didn't author can run arbitrary code as you.
            </div>
            <div>
              <label htmlFor="wiz-mcp-command" style={fieldLabelStyle()}>Command</label>
              <input
                id="wiz-mcp-command"
                style={inputStyle()}
                value={mcpCommand}
                onChange={(e) => setMcpCommand(e.target.value)}
                placeholder="node"
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="wiz-mcp-args" style={fieldLabelStyle()}>Arguments</label>
              <input
                id="wiz-mcp-args"
                style={inputStyle()}
                value={mcpArgs}
                onChange={(e) => setMcpArgs(e.target.value)}
                placeholder="examples/mock-context-source.mjs"
                autoComplete="off"
              />
            </div>
            <label style={css(`display:flex; align-items:center; gap:8px; font-size:12.5px; color:${C.body}; cursor:pointer;`)}>
              <input type="checkbox" checked={mcpTrusted} onChange={(e) => setMcpTrusted(e.target.checked)} />
              I trust this command
            </label>
            {mcpErr && <p style={css('margin:0; font-size:12px; color:var(--cc-amber-text);')}>{mcpErr}</p>}
            <div style={css('display:flex; align-items:center; justify-content:space-between; margin-top:4px;')}>
              <button type="button" style={btnGhost()} onClick={goBack}>Back</button>
              <div style={css('display:flex; gap:8px;')}>
                <button type="button" style={btnGhost()} onClick={skipCompany}>Skip</button>
                <button
                  type="button"
                  style={(mcpBusy || !mcpTrusted) ? btnDisabled() : btnPrimary()}
                  disabled={mcpBusy || !mcpTrusted}
                  onClick={submitCompany}
                >
                  {mcpBusy ? 'Adding…' : 'Add'}
                </button>
              </div>
            </div>
          </StepShell>
        )}

        {step === 'review' && (
          <StepShell
            stepIndex={4}
            title="Review"
            subtitle="Here's what will make up your cascade."
            footer={(
              <>
                <button type="button" style={btnGhost()} onClick={goBack}>Back</button>
                <button type="button" style={successBusy ? btnDisabled() : btnPrimary()} disabled={successBusy} onClick={finishReview}>
                  {successBusy ? 'Resolving…' : 'Finish'}
                </button>
              </>
            )}
          >
            {added.length === 0 ? (
              <p style={css(`margin:0; font-size:13px; color:${C.caption};`)}>No sources were added — you can reopen setup any time from the sidebar.</p>
            ) : (
              <ul style={css('margin:0; padding:0; list-style:none; display:flex; flex-direction:column; gap:8px;')}>
                {added.map((a) => (
                  <li
                    key={a.name}
                    style={css(`display:flex; flex-direction:column; gap:2px; padding:10px 12px; border-radius:9px; background:${C.surface}; border:1px solid ${C.line};`)}
                  >
                    <span style={css(`font-family:${MONO}; font-size:12px; font-weight:600; color:${C.ink};`)}>{a.name} · level {a.level} · {a.kind}</span>
                    <span style={css(`font-size:11.5px; color:${C.caption};`)}>{a.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </StepShell>
        )}

        {step === 'success' && (
          <StepShell
            stepIndex={5}
            title="You're set up"
            subtitle="Your cascade is live."
            footer={(
              <button type="button" style={{ marginLeft: 'auto', ...btnPrimary() }} onClick={onClose}>Done</button>
            )}
          >
            {successConcept ? (
              <div style={css(`padding:12px 14px; border-radius:10px; background:${C.tealFill}; border:1px solid ${C.tealStroke}; font-size:13px; color:${C.tealText};`)}>
                Your agent can now read: <strong style={css(`font-family:${MONO};`)}>{successConcept}</strong>
              </div>
            ) : (
              <p style={css(`margin:0; font-size:13px; color:${C.caption};`)}>Setup complete — no concepts resolved yet. Add content to a layer and reload.</p>
            )}
          </StepShell>
        )}
      </div>
    </div>
  )
}
