// Source setup wizard — live mode only. Two shapes from one component:
//   first run    — guided narrative (personal → optional team → optional
//                  company MCP → review), every step with an editable name
//                  and precedence level, so N sources fit where three did.
//   addingSource — a single step: kind picker + name + level + kind fields.
// Both write the manifest through the engine's source API (POST /api/sources).
// Names are never hardcoded: they derive from what the user picked (folder
// basename / repo slug / MCP command) and stay editable, so a second repo or
// MCP server lands under its own name instead of colliding with "team".
import { useEffect, useRef, useState } from 'react'
import { C, css, MONO } from '../theme'
import { useStore } from '../store'
import { apiFetch } from '../api'
import type { GraphSummary } from '../types'

type StepId = 'welcome' | 'personal' | 'team' | 'company' | 'source' | 'review' | 'success'
const FIRST_RUN_STEPS: StepId[] = ['welcome', 'personal', 'team', 'company', 'review', 'success']
const ADD_STEPS: StepId[] = ['source', 'success']

export type SourceKind = 'files' | 'local' | 'github' | 'mcp'
type RepoAccess = 'public' | 'private'

interface AddedLayer {
  kind: SourceKind | 'github-rest'
  name: string
  level: number
  detail: string
}

// Adding a *private* github source runs a `git clone` server-side (bounded at
// 120s there); public repos go through the REST adapter with only a bounded
// probe. Give these mutations more headroom than apiFetch's default.
const MUTATION_TIMEOUT_MS = 150_000

interface AddResult {
  /** The engine spotted at least one document without indexing the folder. */
  hasDocuments?: boolean
  /** False when the quick look stopped early — "none found" is then unproven. */
  scanComplete?: boolean
}

/** A non-2xx answer from the source API, with the status the retry logic needs. */
export class SourceApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'SourceApiError'
    this.status = status
  }
}

async function postSource(body: Record<string, unknown>): Promise<AddResult> {
  const res = await apiFetch('/api/sources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(MUTATION_TIMEOUT_MS),
  })
  const data = await res.json().catch(() => ({}) as { error?: string })
  if (!res.ok) throw new SourceApiError((data as { error?: string }).error ?? `Server returned ${res.status}`, res.status)
  return data as AddResult
}

/**
 * Adding a source no longer waits for it to be read, so there is no document
 * count yet — the engine indexes in the background and the app shows progress.
 * The one thing worth saying here is when a quick look found nothing, which
 * usually means the wrong folder was picked.
 */
function describeFolder(path: string, result: AddResult): string {
  if (result.hasDocuments === false && result.scanComplete) {
    return `${path} · no documents found — check this is the right folder`
  }
  return `${path} · indexing in the background`
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

// ---- Name derivation --------------------------------------------------------

/** Keep only what the source API's name pattern accepts ([a-zA-Z0-9 _-], ≤40). */
function sanitizeName(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9 _-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-\s]+|[-\s]+$/g, '')
    .slice(0, 40)
    .trim()
}

function lastSegment(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx === -1 ? trimmed : trimmed.slice(idx + 1)
}

/**
 * Default source name from what the user picked: folder basename, repo slug
 * name, or the MCP command's target basename ("npx -y @acme/context-mcp" →
 * "context-mcp"). Editable in the UI — this only seeds the field.
 */
export function deriveSourceName(d: { kind: SourceKind; path?: string; repo?: string; command?: string }): string {
  if (d.kind === 'files' || d.kind === 'local') return sanitizeName(lastSegment(d.path ?? ''))
  if (d.kind === 'github') return sanitizeName(lastSegment((d.repo ?? '').replace(/\.git$/, '')))
  let parts: string[] = []
  try {
    parts = parseCommandLine(d.command ?? '')
  } catch {
    return ''
  }
  const target = [...parts].reverse().find((part) => !part.startsWith('-')) ?? ''
  return sanitizeName(lastSegment(target).replace(/\.(mjs|cjs|js|ts|py|rb|sh|exe|jar)$/i, ''))
}

// ---- Draft state ------------------------------------------------------------

interface Draft {
  kind: SourceKind
  name: string
  /** The user edited the name — stop re-deriving it from path/repo/command. */
  nameTouched: boolean
  level: number
  levelTouched: boolean
  path: string
  repo: string
  repoAccess: RepoAccess
  command: string
  trusted: boolean
}

function makeDraft(kind: SourceKind, level: number): Draft {
  return {
    kind, name: '', nameTouched: false, level, levelTouched: false,
    path: '', repo: '', repoAccess: 'public', command: '', trusted: false,
  }
}

function withDerivedName(d: Draft): Draft {
  return d.nameTouched ? d : { ...d, name: deriveSourceName(d) }
}

/** The one request shape per draft — public repos become the clone-free `github-rest` kind. */
function buildPayload(d: Draft): { body: Record<string, unknown>; kind: AddedLayer['kind'] } | { error: string } {
  const name = d.name.trim()
  if (!name) return { error: 'Give this source a short name, such as “Work notes”.' }
  if (d.kind === 'files' || d.kind === 'local') {
    if (!d.path.trim()) return { error: 'Provide a folder path.' }
    return { kind: d.kind, body: { kind: d.kind, name, level: d.level, path: d.path.trim() } }
  }
  if (d.kind === 'github') {
    if (!d.repo.trim()) return { error: 'Provide a repo as owner/name.' }
    const kind = d.repoAccess === 'public' ? 'github-rest' : 'github'
    return { kind, body: { kind, name, level: d.level, repo: d.repo.trim() } }
  }
  let parts: string[]
  try {
    parts = parseCommandLine(d.command)
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
  if (parts.length === 0) return { error: 'Paste the server command your organization provided.' }
  const [command, ...args] = parts
  // The API also requires this explicit acknowledgement. Keeping the consent
  // bit in the request prevents a caller from bypassing the UI's trust
  // checkbox and turning source creation into an accidental RCE API.
  return { kind: 'mcp', body: { kind: 'mcp', name, level: d.level, command, args, trusted: true } }
}

function draftDetail(d: Draft, kind: AddedLayer['kind'], result: AddResult): string {
  if (kind === 'files' || kind === 'local') return describeFolder(d.path.trim(), result)
  if (kind === 'github-rest') return `${d.repo.trim()} · reads via the GitHub API — no clone`
  if (kind === 'github') return `${d.repo.trim()} · cloned with your git credentials`
  return d.command.trim()
}

function kindLabel(kind: AddedLayer['kind']): string {
  if (kind === 'github-rest') return 'github · public (REST)'
  if (kind === 'github') return 'github · private (clone)'
  return kind
}

// ---- Shared UI --------------------------------------------------------------

function StepShell({
  title, subtitle, children, footer, stepIndex, stepCount,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
  footer?: React.ReactNode
  stepIndex: number
  stepCount: number
}) {
  return (
    <div style={css('display:flex; flex-direction:column; gap:18px; padding:26px 28px 22px;')}>
      <div style={css('display:flex; align-items:center; gap:6px;')}>
        {Array.from({ length: stepCount }, (_, i) => (
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

function errorLine(message: string): React.ReactNode {
  return <p role="alert" style={css('margin:0; font-size:12px; color:var(--cc-amber-text); overflow-wrap:anywhere;')}>{message}</p>
}

/** Generic radio-card group (kind pickers, repo access). */
function ChoiceCards<T extends string>({
  value, onChange, choices, label,
}: {
  value: T
  onChange: (value: T) => void
  choices: Array<{ value: T; title: string; detail: string; badge?: string }>
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} style={css('display:grid; gap:8px;')}>
      {choices.map((choice) => {
        const selected = value === choice.value
        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(choice.value)}
            style={css(`display:grid; grid-template-columns:16px minmax(0,1fr); gap:10px; width:100%; padding:11px 12px; text-align:left; border-radius:10px; border:1px solid ${selected ? C.tealStroke : C.line}; background:${selected ? C.tealFill : C.surface}; color:${C.ink}; cursor:pointer; font:inherit; transition:border-color 150ms ease, background 150ms ease;`)}
          >
            <span aria-hidden="true" style={css(`width:16px; height:16px; margin-top:1px; border-radius:999px; border:1px solid ${selected ? C.tealStrokeE : C.lineStrong}; background:${selected ? C.tealStrokeE : C.raised}; box-shadow:${selected ? `inset 0 0 0 4px ${C.tealFill}` : 'none'};`)} />
            <span style={css('display:grid; gap:2px;')}>
              <strong style={css(`font-size:12.5px; color:${C.ink};`)}>{choice.title}{choice.badge ? ` · ${choice.badge}` : ''}</strong>
              <span style={css(`font-size:11.5px; line-height:1.45; color:${C.caption};`)}>{choice.detail}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

const FOLDER_CHOICES: Array<{ value: 'files' | 'local'; title: string; detail: string; badge?: string }> = [
  {
    value: 'files',
    title: 'Markdown folder',
    badge: 'recommended',
    detail: 'Recommended for repository docs, an Obsidian vault, or a Markdown wiki. ContextCake reads what is already there.',
  },
  {
    value: 'local',
    title: 'ContextCake folder',
    detail: 'For a folder already authored as ContextCake / OKF content with structured frontmatter.',
  },
]

const ALL_KIND_CHOICES: Array<{ value: SourceKind; title: string; detail: string; badge?: string }> = [
  FOLDER_CHOICES[0],
  FOLDER_CHOICES[1],
  {
    value: 'github',
    title: 'GitHub repo',
    detail: 'CLAUDE.md, README, and docs/ from a repository — public repos read via the API, private repos clone.',
  },
  {
    value: 'mcp',
    title: 'MCP server',
    detail: 'A knowledge graph your organization serves over MCP, translated into the cascade at read time.',
  },
]

const REPO_ACCESS_CHOICES: Array<{ value: RepoAccess; title: string; detail: string }> = [
  {
    value: 'public',
    title: 'Public repo (no clone)',
    detail: 'Read through the GitHub API — nothing is cloned and no credentials are needed.',
  },
  {
    value: 'private',
    title: 'Private repo',
    detail: 'Cloned locally using your existing git credentials or SSH.',
  },
]

/** Level defaults per kind when adding a single source (3/3/2/0). */
const ADD_LEVEL_DEFAULTS: Record<SourceKind, number> = { files: 3, local: 3, github: 2, mcp: 0 }

export function LevelStepper({ id, value, onChange }: { id: string; value: number; onChange: (v: number) => void }) {
  const stepBtn = (disabled: boolean): React.CSSProperties => css(
    `width:30px; height:34px; display:grid; place-items:center; border-radius:8px; border:1px solid ${C.line}; background:${disabled ? C.neutralFill : C.surface}; color:${disabled ? C.faint : C.body}; cursor:${disabled ? 'not-allowed' : 'pointer'}; font:inherit; font-size:15px; line-height:1;`,
  )
  return (
    <div>
      <label htmlFor={id} style={fieldLabelStyle()}>Level</label>
      <div style={css('display:flex; align-items:stretch; gap:5px;')} title="Precedence: where layers disagree, the higher level wins per section.">
        <button type="button" aria-label="Lower level" disabled={value <= 0} style={stepBtn(value <= 0)} onClick={() => onChange(Math.max(0, value - 1))}>−</button>
        <output
          id={id}
          aria-label="Level"
          aria-live="polite"
          style={css(`min-width:34px; display:grid; place-items:center; border-radius:8px; border:1px solid ${C.line}; background:${C.surface}; color:${C.ink}; font-family:${MONO}; font-size:14px; font-weight:600;`)}
        >{value}</output>
        <button type="button" aria-label="Raise level" disabled={value >= 9} style={stepBtn(value >= 9)} onClick={() => onChange(Math.min(9, value + 1))}>+</button>
      </div>
    </div>
  )
}

function NameLevelRow({
  idPrefix, draft, onName, onLevel,
}: {
  idPrefix: string
  draft: Draft
  onName: (name: string) => void
  onLevel: (level: number) => void
}) {
  return (
    <div style={css('display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; align-items:start;')}>
      <div>
        <label htmlFor={`${idPrefix}-name`} style={fieldLabelStyle()}>Source name</label>
        <input
          id={`${idPrefix}-name`}
          style={inputStyle()}
          value={draft.name}
          onChange={(e) => onName(e.target.value)}
          placeholder="e.g. Work notes"
          autoComplete="off"
        />
      </div>
      <LevelStepper id={`${idPrefix}-level`} value={draft.level} onChange={onLevel} />
    </div>
  )
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

function GithubFields({
  idPrefix, draft, onRepo, onAccess,
}: {
  idPrefix: string
  draft: Draft
  onRepo: (repo: string) => void
  onAccess: (access: RepoAccess) => void
}) {
  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-repo`} style={fieldLabelStyle()}>Repository</label>
        <input
          id={`${idPrefix}-repo`}
          style={inputStyle()}
          value={draft.repo}
          onChange={(e) => onRepo(e.target.value)}
          placeholder="owner/name"
          autoComplete="off"
        />
      </div>
      <ChoiceCards label="Repository access" value={draft.repoAccess} onChange={onAccess} choices={REPO_ACCESS_CHOICES} />
    </>
  )
}

function McpFields({
  idPrefix, draft, onCommand, onTrusted, autoFocus = false,
}: {
  idPrefix: string
  draft: Draft
  onCommand: (command: string) => void
  onTrusted: (trusted: boolean) => void
  autoFocus?: boolean
}) {
  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-command`} style={fieldLabelStyle()}>Server command</label>
        <input
          id={`${idPrefix}-command`}
          style={inputStyle()}
          value={draft.command}
          onChange={(e) => onCommand(e.target.value)}
          placeholder="npx -y @your-company/context-mcp"
          autoComplete="off"
          aria-describedby={`${idPrefix}-command-help`}
          autoFocus={autoFocus}
        />
        <p id={`${idPrefix}-command-help`} style={css(`margin:6px 0 0; font-size:11.5px; line-height:1.45; color:${C.caption};`)}>
          Paste the complete command exactly as it was provided to you.
        </p>
      </div>
      <div style={css(`padding:10px 12px; border-radius:9px; background:${C.amberFill}; border:1px solid ${C.amberStroke}; font-size:11.5px; color:${C.amberText}; line-height:1.5;`)}>
        This command runs locally with your Mac user permissions.
      </div>
      <label style={css(`display:flex; align-items:center; gap:8px; min-height:32px; font-size:12.5px; color:${C.body}; cursor:pointer;`)}>
        <input type="checkbox" checked={draft.trusted} onChange={(e) => onTrusted(e.target.checked)} />
        I received this command from a source I trust
      </label>
    </>
  )
}

// ---- Wizard -----------------------------------------------------------------

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
  // Frozen at mount: adding the first source flips the shell's live
  // `sources.length > 0` mid-flow (reload() lands while the success fetch is
  // in flight), and letting that swap the step array under a live stepIdx
  // blanks the dialog. Each open mounts a fresh wizard, so capture-once is
  // the correct lifecycle, not a workaround.
  const [isAdding] = useState(addingSource)
  const steps = isAdding ? ADD_STEPS : FIRST_RUN_STEPS
  const [stepIdx, setStepIdx] = useState(0)
  const step = steps[stepIdx]
  const [added, setAdded] = useState<AddedLayer[]>([])

  const [personal, setPersonal] = useState<Draft>(() => makeDraft('files', 3))
  const [personalErr, setPersonalErr] = useState<string | null>(null)
  const [personalBusy, setPersonalBusy] = useState(false)

  const [team, setTeam] = useState<Draft>(() => makeDraft('files', 2))
  const [teamErr, setTeamErr] = useState<string | null>(null)
  const [teamBusy, setTeamBusy] = useState(false)

  const [mcpExpanded, setMcpExpanded] = useState(false)
  const [company, setCompany] = useState<Draft>(() => makeDraft('mcp', 0))
  const [mcpErr, setMcpErr] = useState<string | null>(null)
  const [mcpBusy, setMcpBusy] = useState(false)

  const [addDraft, setAddDraft] = useState<Draft>(() => makeDraft('files', ADD_LEVEL_DEFAULTS.files))
  const [addErr, setAddErr] = useState<string | null>(null)
  const [addBusy, setAddBusy] = useState(false)

  const [successConcept, setSuccessConcept] = useState<string | null>(null)
  const [successIndexing, setSuccessIndexing] = useState(false)
  const [successBusy, setSuccessBusy] = useState(false)

  // Payloads this wizard already sent. A retry after a lost response can 409
  // ("already exists") even though the add landed — for an identical resend
  // that is success, not an error. A 409 on a *first* send is a real clash
  // with an existing source and surfaces inline.
  const attemptedRef = useRef<Set<string>>(new Set())

  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    dialogRef.current?.focus()
  }, [stepIdx])

  const goNext = () => setStepIdx((i) => Math.min(i + 1, steps.length - 1))
  const goBack = () => setStepIdx((i) => Math.max(i - 1, 0))

  const patchDraft = (set: React.Dispatch<React.SetStateAction<Draft>>) => (patch: Partial<Draft>) =>
    set((d) => withDerivedName({ ...d, ...patch }))

  /** POST one draft; push the review entry; report success. Errors surface via setErr. */
  const submitDraft = async (
    draft: Draft,
    setErr: (m: string | null) => void,
    setBusy: (b: boolean) => void,
  ): Promise<boolean> => {
    const built = buildPayload(draft)
    if ('error' in built) { setErr(built.error); return false }
    const key = JSON.stringify(built.body)
    const isRetry = attemptedRef.current.has(key)
    setBusy(true)
    setErr(null)
    try {
      attemptedRef.current.add(key)
      let result: AddResult = {}
      try {
        result = await postSource(built.body)
      } catch (e) {
        // The earlier identical attempt landed server-side (response lost):
        // the source exists, which is what the user asked for.
        if (!(isRetry && e instanceof SourceApiError && e.status === 409)) throw e
      }
      setAdded((prev) => [...prev, {
        kind: built.kind,
        name: String(built.body.name),
        level: draft.level,
        detail: draftDetail(draft, built.kind, result),
      }])
      return true
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  const submitPersonal = async () => {
    if (await submitDraft(personal, setPersonalErr, setPersonalBusy)) goNext()
  }

  const submitTeam = async () => {
    if (await submitDraft(team, setTeamErr, setTeamBusy)) goNext()
  }

  const skipTeam = () => { setTeamErr(null); goNext() }

  const submitCompany = async () => {
    if (!company.trusted) return
    if (await submitDraft(company, setMcpErr, setMcpBusy)) goNext()
  }

  const skipCompany = () => { setMcpErr(null); goNext() }

  /** Reload the app and fetch one sample concept for the success step. */
  const completeSetup = async () => {
    setSuccessBusy(true)
    reload()
    try {
      // A tighter deadline than apiFetch's default: "Resolving…" must never
      // outlive the user's patience — on timeout we land on the success step
      // without a sample concept rather than spinning forever.
      const res = await apiFetch('/api/graph', {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      })
      if (res.ok) {
        const graph = (await res.json()) as GraphSummary
        setSuccessConcept(graph.concepts[0]?.id ?? null)
        setSuccessIndexing(Boolean(graph.indexing))
      }
    } catch {
      setSuccessConcept(null)
      setSuccessIndexing(false)
    } finally {
      setSuccessBusy(false)
      goNext()
    }
  }

  const submitAdd = async () => {
    if (addDraft.kind === 'mcp' && !addDraft.trusted) return
    if (await submitDraft(addDraft, setAddErr, setAddBusy)) await completeSetup()
  }

  const setAddKind = (kind: SourceKind) => {
    setAddDraft((d) => withDerivedName({
      ...d,
      kind,
      level: d.levelTouched ? d.level : ADD_LEVEL_DEFAULTS[kind],
    }))
    setAddErr(null)
  }

  const patchPersonal = patchDraft(setPersonal)
  const patchTeam = patchDraft(setTeam)
  const patchCompany = patchDraft(setCompany)
  const patchAdd = patchDraft(setAddDraft)

  const addSubmitDisabled = addBusy || (addDraft.kind === 'mcp' && (!addDraft.trusted || !addDraft.command.trim()))

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
            stepCount={steps.length}
            title="Welcome to ContextCake"
            subtitle="Start with the knowledge you already use. ContextCake keeps each source separate, then resolves them together for you and your agents."
            footer={(
              <>
                <button type="button" style={btnGhost()} onClick={onClose}>Skip</button>
                <button type="button" style={btnPrimary()} onClick={goNext}>Get started</button>
              </>
            )}
          >
            <div style={css(`padding:12px 14px; border-radius:10px; background:${C.tealFill}; border:1px solid ${C.tealStroke}; font-size:12.5px; color:${C.tealText}; line-height:1.5;`)}>
              Start with a Markdown folder. You can add repositories, more folders, or an MCP server later — as many as you need.
            </div>
          </StepShell>
        )}

        {step === 'personal' && (
          <StepShell
            stepIndex={1}
            stepCount={steps.length}
            title="Add your first source"
            subtitle="Choose the kind of folder you already have. Markdown folders do not need to be converted before ContextCake can read them."
          >
            <ChoiceCards label="Folder format" value={personal.kind as 'files' | 'local'} onChange={(kind) => patchPersonal({ kind })} choices={FOLDER_CHOICES} />
            <NameLevelRow
              idPrefix="wiz-personal"
              draft={personal}
              onName={(name) => { patchPersonal({ name, nameTouched: true }); setPersonalErr(null) }}
              onLevel={(level) => patchPersonal({ level, levelTouched: true })}
            />
            <div>
              <FolderPathField
                id="wiz-personal-path"
                label={personal.kind === 'files' ? 'Markdown folder' : 'ContextCake folder'}
                value={personal.path}
                onChange={(path) => patchPersonal({ path })}
                onError={setPersonalErr}
                placeholder="Choose a folder or paste its path"
              />
              {personalErr && <div style={css('margin-top:8px;')}>{errorLine(personalErr)}</div>}
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
            stepCount={steps.length}
            title="Add a team source (optional)"
            subtitle="Add a shared folder or repository now, or skip it. You can always use Add source from the sidebar later."
          >
            <div style={css('display:flex; gap:6px;')} role="group" aria-label="Team source kind">
              <button
                type="button"
                aria-pressed={team.kind === 'files'}
                style={team.kind === 'files' ? btnPrimary() : btnGhost()}
                onClick={() => { patchTeam({ kind: 'files' }); setTeamErr(null) }}
              >Markdown folder</button>
              <button
                type="button"
                aria-pressed={team.kind === 'local'}
                style={team.kind === 'local' ? btnPrimary() : btnGhost()}
                onClick={() => { patchTeam({ kind: 'local' }); setTeamErr(null) }}
              >ContextCake folder</button>
              <button
                type="button"
                aria-pressed={team.kind === 'github'}
                style={team.kind === 'github' ? btnPrimary() : btnGhost()}
                onClick={() => { patchTeam({ kind: 'github' }); setTeamErr(null) }}
              >GitHub repo</button>
            </div>
            <NameLevelRow
              idPrefix="wiz-team"
              draft={team}
              onName={(name) => { patchTeam({ name, nameTouched: true }); setTeamErr(null) }}
              onLevel={(level) => patchTeam({ level, levelTouched: true })}
            />
            {team.kind === 'local' || team.kind === 'files' ? (
              <FolderPathField
                id="wiz-team-path"
                label={team.kind === 'files' ? 'Markdown folder' : 'ContextCake folder'}
                value={team.path}
                onChange={(path) => patchTeam({ path })}
                onError={setTeamErr}
                placeholder="Choose a folder or paste its path"
              />
            ) : (
              <GithubFields
                idPrefix="wiz-team"
                draft={team}
                onRepo={(repo) => { patchTeam({ repo }); setTeamErr(null) }}
                onAccess={(repoAccess) => patchTeam({ repoAccess })}
              />
            )}
            {teamErr && errorLine(teamErr)}
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
            stepCount={steps.length}
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
                <McpFields
                  idPrefix="wiz-mcp"
                  draft={company}
                  autoFocus
                  onCommand={(command) => { patchCompany({ command }); setMcpErr(null) }}
                  onTrusted={(trusted) => patchCompany({ trusted })}
                />
                <NameLevelRow
                  idPrefix="wiz-mcp"
                  draft={company}
                  onName={(name) => { patchCompany({ name, nameTouched: true }); setMcpErr(null) }}
                  onLevel={(level) => patchCompany({ level, levelTouched: true })}
                />
              </>
            )}
            {mcpErr && errorLine(mcpErr)}
            <div style={css('display:flex; align-items:center; justify-content:space-between; margin-top:4px;')}>
              <button type="button" style={btnGhost()} onClick={goBack}>Back</button>
              <div style={css('display:flex; gap:8px;')}>
                <button type="button" style={mcpExpanded ? btnGhost() : btnPrimary()} onClick={skipCompany}>Skip for now</button>
                {mcpExpanded && (
                  <button
                    type="button"
                    style={(mcpBusy || !company.trusted || !company.command.trim()) ? btnDisabled() : btnPrimary()}
                    disabled={mcpBusy || !company.trusted || !company.command.trim()}
                    onClick={submitCompany}
                  >
                    {mcpBusy ? 'Connecting…' : 'Connect server'}
                  </button>
                )}
              </div>
            </div>
          </StepShell>
        )}

        {step === 'source' && (
          <StepShell
            stepIndex={0}
            stepCount={steps.length}
            title="Add a source"
            subtitle="Pick where this knowledge lives. It joins your cascade under its own name and precedence level."
          >
            <ChoiceCards label="Source kind" value={addDraft.kind} onChange={setAddKind} choices={ALL_KIND_CHOICES} />
            <NameLevelRow
              idPrefix="wiz-add"
              draft={addDraft}
              onName={(name) => { patchAdd({ name, nameTouched: true }); setAddErr(null) }}
              onLevel={(level) => patchAdd({ level, levelTouched: true })}
            />
            {(addDraft.kind === 'files' || addDraft.kind === 'local') && (
              <FolderPathField
                id="wiz-add-path"
                label={addDraft.kind === 'files' ? 'Markdown folder' : 'ContextCake folder'}
                value={addDraft.path}
                onChange={(path) => patchAdd({ path })}
                onError={setAddErr}
                placeholder="Choose a folder or paste its path"
              />
            )}
            {addDraft.kind === 'github' && (
              <GithubFields
                idPrefix="wiz-add"
                draft={addDraft}
                onRepo={(repo) => { patchAdd({ repo }); setAddErr(null) }}
                onAccess={(repoAccess) => patchAdd({ repoAccess })}
              />
            )}
            {addDraft.kind === 'mcp' && (
              <McpFields
                idPrefix="wiz-add"
                draft={addDraft}
                onCommand={(command) => { patchAdd({ command }); setAddErr(null) }}
                onTrusted={(trusted) => patchAdd({ trusted })}
              />
            )}
            {addErr && errorLine(addErr)}
            <div style={css('display:flex; align-items:center; justify-content:space-between; margin-top:4px;')}>
              <button type="button" style={btnGhost()} onClick={onClose}>Cancel</button>
              <button
                type="button"
                style={(addBusy || addSubmitDisabled) ? btnDisabled() : btnPrimary()}
                disabled={addSubmitDisabled}
                onClick={submitAdd}
              >
                {addBusy ? 'Adding…' : 'Add source'}
              </button>
            </div>
          </StepShell>
        )}

        {step === 'review' && (
          <StepShell
            stepIndex={4}
            stepCount={steps.length}
            title="Review"
            subtitle="Here's what will make up your cascade."
            footer={(
              <>
                <button type="button" style={btnGhost()} onClick={goBack}>Back</button>
                <button type="button" style={successBusy ? btnDisabled() : btnPrimary()} disabled={successBusy} onClick={completeSetup}>
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
                    <span style={css(`font-family:${MONO}; font-size:12px; font-weight:600; color:${C.ink};`)}>{a.name} · level {a.level} · {kindLabel(a.kind)}</span>
                    <span style={css(`font-size:11.5px; color:${C.caption};`)}>{a.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </StepShell>
        )}

        {step === 'success' && (
          <StepShell
            stepIndex={steps.length - 1}
            stepCount={steps.length}
            title={isAdding ? 'Source added' : "You're set up"}
            subtitle={isAdding ? 'It joins the cascade as it indexes.' : 'Your cascade is live.'}
            footer={(
              <div style={css('display:flex; justify-content:flex-end; gap:8px; width:100%;')}>
                <button type="button" style={btnGhost()} onClick={onClose}>Done</button>
                {onConnectAgent && added.length > 0 && (
                  <button type="button" style={btnPrimary()} onClick={() => { onClose(); onConnectAgent() }}>Connect an agent</button>
                )}
              </div>
            )}
          >
            {added.length > 0 && isAdding && (
              <ul style={css('margin:0; padding:0; list-style:none; display:flex; flex-direction:column; gap:8px;')}>
                {added.map((a) => (
                  <li
                    key={a.name}
                    style={css(`display:flex; flex-direction:column; gap:2px; padding:10px 12px; border-radius:9px; background:${C.surface}; border:1px solid ${C.line};`)}
                  >
                    <span style={css(`font-family:${MONO}; font-size:12px; font-weight:600; color:${C.ink};`)}>{a.name} · level {a.level} · {kindLabel(a.kind)}</span>
                    <span style={css(`font-size:11.5px; color:${C.caption};`)}>{a.detail}</span>
                  </li>
                ))}
              </ul>
            )}
            {successConcept ? (
              <div style={css(`padding:12px 14px; border-radius:10px; background:${C.tealFill}; border:1px solid ${C.tealStroke}; font-size:13px; color:${C.tealText};`)}>
                Your agent can now read: <strong style={css(`font-family:${MONO};`)}>{successConcept}</strong>
              </div>
            ) : successIndexing ? (
              <p style={css(`margin:0; font-size:13px; color:${C.caption};`)}>Setup complete — your sources are still indexing in the background. Concepts will appear here automatically.</p>
            ) : (
              <p style={css(`margin:0; font-size:13px; color:${C.caption};`)}>Setup complete — no concepts resolved yet. Add content to a layer and reload.</p>
            )}
          </StepShell>
        )}
      </div>
    </div>
  )
}
