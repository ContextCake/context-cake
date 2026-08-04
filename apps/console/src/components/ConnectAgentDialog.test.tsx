// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { ConnectAgentDialog } from './ConnectAgentDialog'

let container: HTMLDivElement
let root: Root
let writeText: ReturnType<typeof vi.fn>
type CliBridge = NonNullable<Window['__CC_DESKTOP']>['cli']
type CliResult = Awaited<ReturnType<CliBridge['getStatus']>>

const SHIM = '/Applications/ContextCake.app/Contents/Resources/bin/contextcake'

let getStatus: Mock<CliBridge['getStatus']>
let install: Mock<CliBridge['install']>

function desktop(status: CliResult['status'] = 'installed', shimPath: string | null = null) {
  getStatus = vi.fn<CliBridge['getStatus']>().mockResolvedValue({ status, message: `CLI is ${status}.`, shimPath })
  install = vi.fn<CliBridge['install']>().mockResolvedValue({ status: 'installed', message: 'Command-line tool installed.', shimPath })
  window.__CC_DESKTOP = {
    getApiToken: async () => 'test',
    version: '0.1.0',
    authState: { signedIn: false },
    cli: {
      getStatus: () => getStatus(),
      install: () => install(),
    },
  }
}

async function render(props: Partial<React.ComponentProps<typeof ConnectAgentDialog>> = {}) {
  const complete = {
    hasSources: true,
    onClose: vi.fn(),
    onOpenSetup: vi.fn(),
    ...props,
  }
  await act(async () => {
    root.render(<ConnectAgentDialog {...complete} />)
  })
  return complete
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.trim() === label)
  if (!found) throw new Error(`Button not found: ${label}`)
  return found
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
  desktop()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('ConnectAgentDialog', () => {
  it('switches clients and copies the tailored setup prompt', async () => {
    await render()
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Claude Code')

    await act(async () => button('Codex').click())
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toContain('codex mcp add contextcake -- contextcake mcp')

    const copyPrompt = container.querySelector<HTMLButtonElement>('[aria-label="Copy Codex setup prompt"]')
    await act(async () => copyPrompt?.click())
    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText.mock.calls[0][0]).toContain('Connect ContextCake to Codex')
    expect(container.textContent).toContain('Copied to clipboard.')
  })

  it('offers source setup instead of connection payloads when the cascade is empty', async () => {
    const props = await render({ hasSources: false })
    expect(container.querySelector('[role="tablist"]')).toBeNull()
    expect(container.textContent).toContain('Set up your cascade first')

    await act(async () => button('Finish source setup').click())
    expect(props.onClose).toHaveBeenCalledOnce()
    expect(props.onOpenSetup).toHaveBeenCalledOnce()
  })

  it('installs a missing CLI through the fixed desktop bridge', async () => {
    desktop('missing')
    await render()
    expect(container.textContent).toContain('Install the command-line tool')

    await act(async () => button('Install tool').click())
    expect(install).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Command-line tool installed')
  })

  it('connects through the app shim path when the CLI name is unusable', async () => {
    desktop('missing', SHIM)
    await render()

    // The PATH install is an optional nicety, not a gate on connecting.
    expect(container.textContent).toContain('Command-line tool is optional')
    const panel = () => container.querySelector('[role="tabpanel"]')?.textContent ?? ''
    expect(panel()).toContain(`claude mcp add --scope user contextcake -- "${SHIM}" mcp`)

    const copyPrompt = container.querySelector<HTMLButtonElement>('[aria-label="Copy Claude Code setup prompt"]')
    await act(async () => copyPrompt?.click())
    expect(writeText.mock.calls[0][0]).toContain(`"${SHIM}" mcp`)

    // Installing the shortcut flips every payload back to the short name.
    await act(async () => button('Install tool').click())
    expect(panel()).toContain('claude mcp add --scope user contextcake -- contextcake mcp')
    expect(panel()).not.toContain(SHIM)
  })

  it('shows the move-to-Applications gate and never an absolute path while translocated', async () => {
    // Even if a path leaked through IPC in the blocked state, the dialog must
    // gate on status — a translocated/DMG path dies when the image unmounts.
    desktop('blocked', SHIM)
    await render()

    expect(container.textContent).toContain('Move ContextCake to Applications')
    const panel = container.querySelector('[role="tabpanel"]')?.textContent ?? ''
    expect(panel).toContain('claude mcp add --scope user contextcake -- contextcake mcp')
    expect(panel).not.toContain(SHIM)
    expect(panel).not.toContain('/Volumes/')
  })

  it('falls back to a manual copy window when clipboard permission is blocked', async () => {
    writeText.mockRejectedValue(new Error('blocked'))
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('copied manually')
    await render()

    const copySetup = container.querySelector<HTMLButtonElement>('[aria-label="Copy Claude Code setup"]')
    await act(async () => copySetup?.click())
    expect(prompt).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Clipboard access was unavailable')
  })

  it('announces a copy failure when both clipboard paths fail', async () => {
    writeText.mockRejectedValue(new Error('blocked'))
    vi.spyOn(window, 'prompt').mockImplementation(() => { throw new Error('blocked') })
    await render()

    const copySetup = container.querySelector<HTMLButtonElement>('[aria-label="Copy Claude Code setup"]')
    await act(async () => copySetup?.click())
    expect(container.textContent).toContain('Copy failed')
  })

  it('closes on Escape and keeps forward Tab navigation inside the dialog', async () => {
    const props = await render()
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')
    const focusable = Array.from(dialog?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [])
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    last.focus()

    await act(async () => dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })))
    expect(document.activeElement).toBe(first)

    await act(async () => dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(props.onClose).toHaveBeenCalledOnce()
  })
})
