import { useEffect, useRef, useState } from 'react'
import { DEFAULT_HARNESS_ID, HARNESS_DEFINITIONS, harnessById, type HarnessIcon, type HarnessId } from '../connect-agent'

type CopyTarget = 'prompt' | 'setup' | 'verify' | 'first-prompt'
type CopyState = { target: CopyTarget; kind: 'copied' | 'manual' | 'failed' } | null
type CliStatus = 'loading' | 'installed' | 'missing' | 'stale' | 'conflict' | 'blocked' | 'development'

interface ConnectAgentDialogProps {
  hasSources: boolean
  onClose: () => void
  onOpenSetup: () => void
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

function HarnessGlyph({ icon }: { icon: HarnessIcon }) {
  if (icon === 'terminal') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 7 4 5-4 5M11 17h8" /></svg>
  if (icon === 'cube') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4.5 7.7 7.5 4.2 7.5-4.2M12 12v9" /></svg>
  if (icon === 'cursor') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 3 14 9-7 2-3 7L5 3Z" /></svg>
  if (icon === 'desktop') return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5-5 7 5 7M15 5l5 7-5 7M13.5 3 10.5 21" /></svg>
}

function CopyGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
}

function copyLabel(state: CopyState, target: CopyTarget, idle: string): string {
  if (state?.target !== target) return idle
  if (state.kind === 'copied') return 'Copied'
  if (state.kind === 'manual') return 'Copy manually'
  return 'Copy failed'
}

function cliCopy(status: CliStatus): { title: string; detail: string; tone: string } {
  if (status === 'installed') return { title: 'Command-line tool installed', detail: '`contextcake mcp` is ready for local clients.', tone: 'ready' }
  if (status === 'stale') return { title: 'Command-line tool needs refreshing', detail: 'Reconnect it to this copy of ContextCake before continuing.', tone: 'warn' }
  if (status === 'conflict') return { title: 'Another command uses this name', detail: 'ContextCake will not replace a real file at `/usr/local/bin/contextcake`.', tone: 'error' }
  if (status === 'blocked') return { title: 'Move ContextCake to Applications', detail: 'Reopen the installed app before adding its command-line tool.', tone: 'warn' }
  if (status === 'development') return { title: 'Development build', detail: 'CLI installation is available in packaged builds. Generated production setup remains unchanged.', tone: 'neutral' }
  if (status === 'loading') return { title: 'Checking command-line tool…', detail: 'This only inspects ContextCake’s own command.', tone: 'neutral' }
  return { title: 'Install the command-line tool', detail: 'The harness commands below depend on `contextcake mcp`.', tone: 'warn' }
}

export function ConnectAgentDialog({ hasSources, onClose, onOpenSetup }: ConnectAgentDialogProps) {
  const [activeId, setActiveId] = useState<HarnessId>(DEFAULT_HARNESS_ID)
  const [copyState, setCopyState] = useState<CopyState>(null)
  const [cliStatus, setCliStatus] = useState<CliStatus>('loading')
  const [cliBusy, setCliBusy] = useState(false)
  const [cliNotice, setCliNotice] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  const firstTabRef = useRef<HTMLButtonElement>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const previousFocus = useRef<HTMLElement | null>(null)
  const harness = harnessById(activeId)
  const desktopCli = window.__CC_DESKTOP?.cli

  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null
    const target = hasSources ? firstTabRef.current : dialogRef.current?.querySelector<HTMLElement>('button')
    target?.focus()
    return () => previousFocus.current?.focus()
  }, [hasSources])

  useEffect(() => {
    if (!hasSources || !desktopCli) return
    let live = true
    desktopCli.getStatus()
      .then((result) => { if (live) setCliStatus(result.status) })
      .catch(() => { if (live) setCliStatus('missing') })
    return () => { live = false }
  }, [desktopCli, hasSources])

  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const announceCopy = (target: CopyTarget, kind: NonNullable<CopyState>['kind']) => {
    setCopyState({ target, kind })
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopyState(null), 2400)
  }

  const copy = async (target: CopyTarget, value: string) => {
    if (!navigator.clipboard || !window.isSecureContext) {
      const copied = window.prompt('Copy this text:', value)
      announceCopy(target, copied === null ? 'failed' : 'manual')
      return
    }
    try {
      await navigator.clipboard.writeText(value)
      announceCopy(target, 'copied')
    } catch {
      try {
        const copied = window.prompt('Clipboard access was blocked. Copy this text:', value)
        announceCopy(target, copied === null ? 'failed' : 'manual')
      } catch {
        announceCopy(target, 'failed')
      }
    }
  }

  const installCli = async () => {
    if (!desktopCli || cliBusy) return
    setCliBusy(true)
    setCliNotice('')
    try {
      const result = await desktopCli.install()
      setCliStatus(result.status)
      setCliNotice(result.message)
    } catch {
      setCliNotice('ContextCake could not start the installer. Use ContextCake → Install Command Line Tool… and try again.')
    } finally {
      setCliBusy(false)
    }
  }

  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab' || !dialogRef.current) return
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true')
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const finishSetup = () => {
    onClose()
    onOpenSetup()
  }

  const cli = cliCopy(cliStatus)
  const canInstall = cliStatus === 'missing' || cliStatus === 'stale'

  return (
    <div className="cc-connect-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div
        ref={dialogRef}
        className="cc-connect-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cc-connect-title"
        onKeyDown={onDialogKeyDown}
      >
        <header className="cc-connect-header">
          <div>
            <div className="cc-connect-kicker">Local MCP connection</div>
            <h2 id="cc-connect-title">Connect an agent</h2>
            <p>Choose your client. ContextCake will prepare the prompt and exact setup it needs.</p>
          </div>
          <button type="button" className="cc-connect-close" onClick={onClose} aria-label="Close Connect an agent">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>

        {!hasSources ? (
          <div className="cc-connect-empty">
            <div className="cc-connect-empty-mark" aria-hidden="true"><span /><span /><span /></div>
            <h3>Set up your cascade first</h3>
            <p>An agent needs at least one ContextCake source to connect to. Finish source setup, then return here.</p>
            <button type="button" className="cc-connect-primary" onClick={finishSetup}>Finish source setup</button>
          </div>
        ) : (
          <>
            <div className="cc-harness-tabs" role="tablist" aria-label="AI client">
              {HARNESS_DEFINITIONS.map((item, index) => (
                <button
                  key={item.id}
                  ref={index === 0 ? firstTabRef : undefined}
                  type="button"
                  role="tab"
                  aria-selected={activeId === item.id}
                  aria-controls="cc-harness-panel"
                  className="cc-harness-tab"
                  onClick={() => { setActiveId(item.id); setCopyState(null) }}
                >
                  <span className="cc-harness-glyph"><HarnessGlyph icon={item.icon} /></span>
                  <span>{item.shortLabel}</span>
                </button>
              ))}
            </div>

            <div id="cc-harness-panel" className="cc-connect-body" role="tabpanel">
              <div className="cc-connect-meta">
                <div>
                  <strong>{harness.label}</strong>
                  <span>{harness.summary}</span>
                </div>
                <div className="cc-connect-trust" aria-label="Read-only and runs locally">
                  <span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 11V8a7 7 0 0 1 14 0v3M4 11h16v10H4z" /></svg>Read-only</span>
                  <span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M4 8l8-5 8 5M4 16l8 5 8-5" /></svg>Runs locally</span>
                </div>
              </div>

              <section className="cc-agent-prompt">
                <div>
                  <div className="cc-connect-section-label">Give your agent everything it needs</div>
                  <p>Paste one prompt into {harness.label} and let it guide the connection.</p>
                </div>
                <button type="button" className="cc-copy-button cc-copy-button--primary" onClick={() => copy('prompt', harness.prompt)} aria-label={`Copy ${harness.label} setup prompt`}>
                  <CopyGlyph />{copyLabel(copyState, 'prompt', 'Copy prompt')}
                </button>
              </section>

              <ol className="cc-connect-steps">
                <li>
                  <span className="cc-step-number">1</span>
                  <div className="cc-step-content">
                    <div className={`cc-cli-status cc-cli-status--${cli.tone}`}>
                      <span className="cc-cli-dot" aria-hidden="true" />
                      <div><strong>{cli.title}</strong><p>{cli.detail}</p></div>
                      {canInstall && (
                        <button type="button" onClick={installCli} disabled={cliBusy}>{cliBusy ? 'Installing…' : 'Install tool'}</button>
                      )}
                    </div>
                    {cliNotice && <p className="cc-inline-notice" role="status">{cliNotice}</p>}
                  </div>
                </li>

                <li>
                  <span className="cc-step-number">2</span>
                  <div className="cc-step-content">
                    <h3>{harness.setupTitle}</h3>
                    <p>{harness.setupDetail}</p>
                    <div className="cc-code-block">
                      <pre><code>{harness.setupPayload}</code></pre>
                      <button type="button" className="cc-code-copy" onClick={() => copy('setup', harness.setupPayload)} aria-label={`Copy ${harness.label} setup`}>
                        <CopyGlyph />{copyLabel(copyState, 'setup', 'Copy')}
                      </button>
                    </div>
                  </div>
                </li>

                <li>
                  <span className="cc-step-number">3</span>
                  <div className="cc-step-content">
                    <h3>Verify the connection</h3>
                    <p>{harness.verifyDetail}</p>
                    {harness.verifyPayload && (
                      <div className="cc-code-block cc-code-block--compact">
                        <pre><code>{harness.verifyPayload}</code></pre>
                        <button type="button" className="cc-code-copy" onClick={() => copy('verify', harness.verifyPayload ?? '')} aria-label={`Copy ${harness.label} verification command`}>
                          <CopyGlyph />{copyLabel(copyState, 'verify', 'Copy')}
                        </button>
                      </div>
                    )}
                    <div className="cc-first-prompt">
                      <span>{harness.firstPrompt}</span>
                      <button type="button" className="cc-copy-button" onClick={() => copy('first-prompt', harness.firstPrompt)} aria-label="Copy first-use prompt">
                        <CopyGlyph />{copyLabel(copyState, 'first-prompt', 'Copy first prompt')}
                      </button>
                    </div>
                  </div>
                </li>
              </ol>

              <div className="cc-connect-footer">
                <span role="status" aria-live="polite">
                  {copyState?.kind === 'copied' && 'Copied to clipboard.'}
                  {copyState?.kind === 'manual' && 'Clipboard access was unavailable. The text is selected in a manual copy window.'}
                  {copyState?.kind === 'failed' && 'Copy failed. Select the visible text and copy it manually.'}
                </span>
                <a href={harness.docsUrl} target="_blank" rel="noreferrer">View {harness.label} documentation <span aria-hidden="true">↗</span></a>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
