// First-run setup wizard — live mode only, shown when the resolved cascade
// has zero sources. Walks the user through writing a manifest via the
// playground server's source API (POST /api/sources). See TASK 4B.
import { useEffect, useRef, useState } from 'react'
import { C, css, MONO } from '../theme'
import { useStore } from '../store'
import { apiFetch } from '../api'
import type { GraphSummary } from '../types'

type StepId = 'welcome' | 'personal' | 'team' | 'company' | 'review' | 'success'
const STEPS: StepId[] = ['welcome', 'personal', 'team', 'company', 'review', 'success']

interface AddedLayer {
  kind: 'files' | 'local' | 'github' | 'mcp'
  name: string
  level: number
  detail: string
}

async function postSource(body: Record<string, unknown>): Promise<void> {
  const res = await apiFetch('/api/sources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}) as { error?: string })
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Server returned ${res.status}`)
}

async function syncSource(name: string): Promise<void> {
  const res = await apiFetch(`/api/sources/sync?name=${encodeURIComponent(name)}`, { method: 'POST' })
  const data = await res.json().catch(() => ({}) as { error?: string })
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Server returned ${res.status}`)
}

/** Split a user-provided command without invoking a shell. */
export function parseCommandLine(value: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let escaping = false
  let started = false

  for (const char of value.trim()) {
    if (escaping) {
      current += char
      escaping = false
      started = true
    } else if (char === '\\' && quote !== "'") {
      escaping = true
      started = true
    } else if (quote) {
      if (char === quote) quote = null
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) {
        parts.push(current)
        current = ''
        started = false
      }
    } else {
      current += char
      started = true
    }
  }

  if (escaping || quote) throw new Error('The server command has an unfinished quote or escape.')
  if (started) parts.push(current)
  return parts
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

function FolderPathField({
  id, value, placeholder, label, onChange, onError,
}: {
  id: string
  value: string
  placeholder: string
  label: string
  onChange: (value: string) => void
  onError: (message: string | null) => void
}) {
  const chooseFolder = window.__CC_DESKTOP?.chooseFolder
  const [choosing, setChoosing] = useState(false)

  const browse = async () => {
    if (!chooseFolder) return
    setChoosing(true)
    onError(null)
    try {
      const selected = await chooseFolder()
      if (selected) onChange(selected)
    } catch {
      onError('The folder browser could not open. You can still paste a folder path.')
    } finally {
      setChoosing(false)
    }
  }

  return (
    <div>
      <label htmlFor={id} style={fieldLabelStyle()}>{label}</label>
      <div style={css('display:flex; align-items:stretch; gap:8px;')}>
        <input
          id={id}
          style={{ ...inputStyle(), flex: '1 1 auto', minWidth: 0, width: 'auto' }}
          value={value}
          onChange={(e) => { onChange(e.target.value); onError(null) }}
          placeholder={placeholder}
          autoComplete="off"
        />
        {chooseFolder && (
          <button
            type="button"
            style={choosing ? btnDisabled() : btnGhost()}
            disabled={choosing}
            onClick={browse}
            aria-label={`Choose ${label.toLowerCase()}`}
          >
            {choosing ? 'Opening…' : 'Choose…'}
          </button>
        )}
      </div>
    </div>
  )
}

function SourceKindChooser({
  value, onChange,
}: {
  value: 'files' | 'local'
  onChange: (value: 'files' | 'local') => void
}) {
  const choices: Array<{ value: 'files' | 'local'; title: string; detail: string }> = [
    {
      value: 'files',
      title: 'Markdown folder',
      detail: 'Recommended for repository docs, an Obsidian vault, or a Markdown wiki. ContextCake reads what is already there.',
    },
    {
      value: 'local',
      title: 'ContextCake folder',
      detail: 'For a folder already authored as ContextCake / OKF content with structured frontmatter.',
    },
  ]

  return (
    <div role="radiogroup" aria-label="Folder format" style={css('display:grid; gap:8px;')}>
      {choices.map((choice) => {
        const selected = value === choice.value
        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(choice.value)}
            style={css(`display:grid; grid-template-columns:16px minmax(0,1fr); gap:10px; width:100%; padding:11px 12px; text-align:left; border-radius:10px; border:1px solid ${selected ? C.tealStroke : C.line}; background:${selected ? C.tealFill : C.surface}; color:${C.ink}; cursor:pointer; font:inherit;`)}
          >
            <span aria-hidden="true" style={css(`width:16px; height:16px; margin-top:1px; border-radius:999px; border:1px solid ${selected ? C.tealStrokeE : C.lineStrong}; background:${selected ? C.tealStrokeE : C.raised}; box-shadow:${selected ? `inset 0 0 0 4px ${C.tealFill}` : 'none'};`)} />
            <span style={css('display:grid; gap:2px;')}>
              <strong style={css(`font-size:12.5px; color:${C.ink};`)}>{choice.title}{choice.value === 'files' ? ' · recommended' : ''}</strong>
              <span style={css(`font-size:11.5px; line-height:1.45; color:${C.caption};`)}>{choice.detail}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function SetupWizard({
  onClose,
  onConnectAgent,
  addingSource = false,
}: {
  onClose: () => void
  onConnectAgent?: () => void
  addingSource?: boolean
}) {
  const { reload } = useStore()
  const [stepIdx, setStepIdx] = useState(0)
  const step = STEPS[stepIdx]
  const [added, setAdded] = useState<AddedLayer[]>([])

  const [personalKind, setPersonalKind] = useState<'files' | 'local'>('files')
  const [personalName, setPersonalName] = useState(addingSource ? '' : 'personal')
  const [personalPath, setPersonalPath] = useState('')
  const [personalErr, setPersonalErr] = useState<string | null>(null)
  const [personalBusy, setPersonalBusy] = useState(false)

  const [teamKind, setTeamKind] = useState<'files' | 'local' | 'github'>('files')
  const [teamPath, setTeamPath] = useState('')
  const [teamRepo, setTeamRepo] = useState('')
  const [teamErr, setTeamErr] = useState<string | null>(null)
  const [teamBusy, setTeamBusy] = useState(false)

  const [mcpExpanded, setMcpExpanded] = useState(false)
  const [mcpCommandLine, setMcpCommandLine] = useState('')
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
    if (!personalName.trim()) { setPersonalErr('Give this source a short name, such as “Work notes”.'); return }
    if (!personalPath.trim()) { setPersonalErr('Provide a folder path.'); return }
    setPersonalBusy(true)
    setPersonalErr(null)
    try {
      await postSource({ kind: personalKind, name: personalName.trim(), level: 3, path: personalPath.trim() })
      setAdded((prev) => [...prev, { kind: personalKind, name: personalName.trim(), level: 3, detail: personalPath.trim() }])
      goNext()
    } catch (e) {
      setPersonalErr(e instanceof Error ? `${e.message} Choose a different source name and try again.` : String(e))
    } finally {
      setPersonalBusy(false)
    }
  }

  const submitTeam = async () => {
    setTeamBusy(true)
    setTeamErr(null)
    try {
      if (teamKind === 'local' || teamKind === 'files') {
        if (!teamPath.trim()) { setTeamErr('Provide a folder path.'); setTeamBusy(false); return }
        await postSource({ kind: teamKind, name: 'team', level: 2, path: teamPath.trim() })
        setAdded((prev) => [...prev, { kind: teamKind, name: 'team', level: 2, detail: teamPath.trim() }])
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
    if (!mcpTrusted) return
    let parts: string[]
    try {
      parts = parseCommandLine(mcpCommandLine)
    } catch (e) {
      setMcpErr(e instanceof Error ? e.message : String(e))
      return
    }
    if (parts.length === 0) { setMcpErr('Paste the server command your organization provided.'); return }
    setMcpBusy(true)
    setMcpErr(null)
    try {
      const [command, ...args] = parts
      await postSource({ kind: 'mcp', name: 'company', level: 0, command, args })
      setAdded((prev) => [...prev, { kind: 'mcp', name: 'company', level: 0, detail: mcpCommandLine.trim() }])
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
      const res = await apiFetch('/api/graph', { headers: { accept: 'application/json' } })
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
            title={addingSource ? 'Add a source' : 'Welcome to ContextCake'}
            subtitle={addingSource
              ? 'Choose another local folder or knowledge service to add to your cascade.'
              : 'Start with the knowledge you already use. ContextCake keeps each source separate, then resolves them together for you and your agents.'}
            footer={(
              <>
                <button type="button" style={btnGhost()} onClick={onClose}>Skip</button>
                <button type="button" style={btnPrimary()} onClick={goNext}>{addingSource ? 'Choose a source' : 'Get started'}</button>
              </>
            )}
          >
            <div style={css(`padding:12px 14px; border-radius:10px; background:${C.tealFill}; border:1px solid ${C.tealStroke}; font-size:12.5px; color:${C.tealText}; line-height:1.5;`)}>
              {addingSource
                ? 'You can add a repository, Obsidian vault, wiki export, or a structured ContextCake folder without moving its files.'
                : 'Start with a Markdown folder. You can add a team source or company MCP server later.'}
            </div>
          </StepShell>
        )}

        {step === 'personal' && (
          <StepShell
            stepIndex={1}
            title={addingSource ? 'Choose a local source' : 'Add your first source'}
            subtitle="Choose the kind of folder you already have. Markdown folders do not need to be converted before ContextCake can read them."
          >
            <SourceKindChooser value={personalKind} onChange={setPersonalKind} />
            <div>
              <label htmlFor="wiz-personal-name" style={fieldLabelStyle()}>Source name</label>
              <input
                id="wiz-personal-name"
                style={inputStyle()}
                value={personalName}
                onChange={(e) => { setPersonalName(e.target.value); setPersonalErr(null) }}
                placeholder="e.g. Work notes"
                autoComplete="off"
              />
            </div>
            <div>
              <FolderPathField
                id="wiz-personal-path"
                label={personalKind === 'files' ? 'Markdown folder' : 'ContextCake folder'}
                value={personalPath}
                onChange={setPersonalPath}
                onError={setPersonalErr}
                placeholder="Choose a folder or paste its path"
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
            title="Add a team source (optional)"
            subtitle="Add another local folder now, or skip it. You can always use Add source from the sidebar later."
          >
            <div style={css('display:flex; gap:6px;')}>
              <button
                type="button"
                style={teamKind === 'files' ? btnPrimary() : btnGhost()}
                onClick={() => setTeamKind('files')}
              >Markdown folder</button>
              <button
                type="button"
                style={teamKind === 'local' ? btnPrimary() : btnGhost()}
                onClick={() => setTeamKind('local')}
              >ContextCake folder</button>
              <button
                type="button"
                style={teamKind === 'github' ? btnPrimary() : btnGhost()}
                onClick={() => setTeamKind('github')}
              >GitHub repo</button>
            </div>
            {teamKind === 'local' || teamKind === 'files' ? (
              <FolderPathField
                id="wiz-team-path"
                label={teamKind === 'files' ? 'Markdown folder' : 'ContextCake folder'}
                value={teamPath}
                onChange={setTeamPath}
                onError={setTeamErr}
                placeholder="Choose a folder or paste its path"
              />
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
            title="Company knowledge (optional)"
            subtitle="Connect this only if your organization already gave you an MCP server command. You can safely skip it and add one later."
          >
            {!mcpExpanded ? (
              <div style={css(`display:flex; flex-direction:column; align-items:flex-start; gap:9px; padding:14px 15px; border-radius:10px; background:${C.surface}; border:1px solid ${C.line};`)}>
                <strong style={css(`font-size:13px; color:${C.ink};`)}>Already have a company MCP server?</strong>
                <span style={css(`font-size:12.5px; line-height:1.5; color:${C.caption};`)}>
                  Your IT or platform team should provide a command to start it. If that doesn't sound familiar, skip this step.
                </span>
                <button type="button" style={btnGhost()} onClick={() => setMcpExpanded(true)}>Connect an MCP server</button>
              </div>
            ) : (
              <>
                <div>
                  <label htmlFor="wiz-mcp-command" style={fieldLabelStyle()}>Server command</label>
                  <input
                    id="wiz-mcp-command"
                    style={inputStyle()}
                    value={mcpCommandLine}
                    onChange={(e) => { setMcpCommandLine(e.target.value); setMcpErr(null) }}
                    placeholder="npx -y @your-company/context-mcp"
                    autoComplete="off"
                    aria-describedby="wiz-mcp-command-help"
                    autoFocus
                  />
                  <p id="wiz-mcp-command-help" style={css(`margin:6px 0 0; font-size:11.5px; line-height:1.45; color:${C.caption};`)}>
                    Paste the complete command exactly as it was provided to you.
                  </p>
                </div>
                <div style={css(`padding:10px 12px; border-radius:9px; background:${C.amberFill}; border:1px solid ${C.amberStroke}; font-size:11.5px; color:${C.amberText}; line-height:1.5;`)}>
                  This command runs locally with your Mac user permissions.
                </div>
                <label style={css(`display:flex; align-items:center; gap:8px; min-height:32px; font-size:12.5px; color:${C.body}; cursor:pointer;`)}>
                  <input type="checkbox" checked={mcpTrusted} onChange={(e) => setMcpTrusted(e.target.checked)} />
                  I received this command from a source I trust
                </label>
              </>
            )}
            {mcpErr && <p role="alert" style={css('margin:0; font-size:12px; color:var(--cc-amber-text);')}>{mcpErr}</p>}
            <div style={css('display:flex; align-items:center; justify-content:space-between; margin-top:4px;')}>
              <button type="button" style={btnGhost()} onClick={goBack}>Back</button>
              <div style={css('display:flex; gap:8px;')}>
                <button type="button" style={mcpExpanded ? btnGhost() : btnPrimary()} onClick={skipCompany}>Skip for now</button>
                {mcpExpanded && (
                  <button
                    type="button"
                    style={(mcpBusy || !mcpTrusted || !mcpCommandLine.trim()) ? btnDisabled() : btnPrimary()}
                    disabled={mcpBusy || !mcpTrusted || !mcpCommandLine.trim()}
                    onClick={submitCompany}
                  >
                    {mcpBusy ? 'Connecting…' : 'Connect server'}
                  </button>
                )}
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
              <div style={css('display:flex; justify-content:flex-end; gap:8px; width:100%;')}>
                <button type="button" style={btnGhost()} onClick={onClose}>Done</button>
                {onConnectAgent && added.length > 0 && (
                  <button type="button" style={btnPrimary()} onClick={() => { onClose(); onConnectAgent() }}>Connect an agent</button>
                )}
              </div>
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
