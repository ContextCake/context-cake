// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseCommandLine, SetupWizard } from './SetupWizard'

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), reload: vi.fn() }))

vi.mock('../api', () => ({ apiFetch: mocks.apiFetch }))
vi.mock('../store', () => ({ useStore: () => ({ reload: mocks.reload }) }))

let container: HTMLDivElement
let root: Root

function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.trim() === label)
  if (!match) throw new Error(`Button not found: ${label}`)
  return match
}

function sourceChoice(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((item) => item.textContent?.includes(label))
  if (!match) throw new Error(`Source choice not found: ${label}`)
  return match
}

async function enter(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)
  await act(async () => {
    if (!input) throw new Error(`Input not found: ${selector}`)
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.apiFetch.mockReset()
  mocks.reload.mockReset()
  delete window.__CC_DESKTOP
  mocks.apiFetch.mockImplementation(async (url: string) => new Response(
    JSON.stringify(url === '/api/graph' ? { concepts: [{ id: 'systems/app' }] } : {}),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ))
})

afterEach(async () => {
  await act(async () => root.unmount())
  delete window.__CC_DESKTOP
  container.remove()
})

describe('SetupWizard connection handoff', () => {
  it('adds a repository, vault, or wiki folder as the Markdown source users expect', async () => {
    await act(async () => root.render(<SetupWizard onClose={vi.fn()} />))

    await act(async () => button('Get started').click())
    expect(container.textContent).toContain('Recommended for repository docs, an Obsidian vault, or a Markdown wiki')
    expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain('Markdown folder')
    await enter('#wiz-personal-path', '/tmp/work-vault')
    await act(async () => button('Next').click())

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/sources', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ kind: 'files', name: 'personal', level: 3, path: '/tmp/work-vault' }),
    }))
  })

  it('makes the structured ContextCake option deliberate rather than the default', async () => {
    await act(async () => root.render(<SetupWizard onClose={vi.fn()} />))

    await act(async () => button('Get started').click())
    await act(async () => sourceChoice('ContextCake folder').click())
    await enter('#wiz-personal-path', '/tmp/structured-context')
    await act(async () => button('Next').click())

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/sources', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ kind: 'local', name: 'personal', level: 3, path: '/tmp/structured-context' }),
    }))
  })

  it('asks for a human name when adding another source', async () => {
    await act(async () => root.render(<SetupWizard addingSource onClose={vi.fn()} />))

    await act(async () => button('Choose a source').click())
    await enter('#wiz-personal-path', '/tmp/repo-b')
    await act(async () => button('Next').click())
    expect(container.textContent).toContain('Give this source a short name')

    await enter('#wiz-personal-name', 'Repo B')
    await act(async () => button('Next').click())
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/sources', expect.objectContaining({
      body: JSON.stringify({ kind: 'files', name: 'Repo B', level: 3, path: '/tmp/repo-b' }),
    }))
  })

  it('keeps advanced MCP fields hidden until the user chooses to connect a server', async () => {
    await act(async () => root.render(<SetupWizard onClose={vi.fn()} />))

    await act(async () => button('Get started').click())
    await enter('#wiz-personal-path', '/tmp/contextcake-personal')
    await act(async () => button('Next').click())
    await act(async () => button('Skip').click())

    expect(container.querySelector('#wiz-mcp-command')).toBeNull()
    expect(button('Skip for now')).toBeTruthy()
    await act(async () => button('Connect an MCP server').click())
    const command = container.querySelector<HTMLInputElement>('#wiz-mcp-command')
    expect(command).toBeTruthy()
    expect(document.activeElement).toBe(command)
    expect(button('Connect server').disabled).toBe(true)
  })

  it('uses the native folder browser when the desktop bridge is available', async () => {
    const chooseFolder = vi.fn().mockResolvedValue('/Users/person/ContextCake/personal')
    window.__CC_DESKTOP = {
      token: 'test',
      version: '0.1.0',
      authState: { signedIn: false },
      chooseFolder,
      cli: {
        getStatus: vi.fn().mockResolvedValue({ status: 'installed', message: 'CLI is installed.' }),
        install: vi.fn().mockResolvedValue({ status: 'installed', message: 'CLI is installed.' }),
      },
    }
    await act(async () => root.render(<SetupWizard onClose={vi.fn()} />))

    await act(async () => button('Get started').click())
    await act(async () => button('Choose…').click())

    expect(chooseFolder).toHaveBeenCalledOnce()
    expect(container.querySelector<HTMLInputElement>('#wiz-personal-path')?.value)
      .toBe('/Users/person/ContextCake/personal')
  })

  it('makes Connect an agent the primary next action after a source is added', async () => {
    const onClose = vi.fn()
    const onConnectAgent = vi.fn()
    await act(async () => root.render(<SetupWizard onClose={onClose} onConnectAgent={onConnectAgent} />))

    await act(async () => button('Get started').click())
    await enter('#wiz-personal-path', '/tmp/contextcake-personal')
    await act(async () => button('Next').click())
    await act(async () => button('Skip').click())
    await act(async () => button('Skip for now').click())
    await act(async () => button('Finish').click())

    expect(button('Connect an agent')).toBeTruthy()
    await act(async () => button('Connect an agent').click())
    expect(onClose).toHaveBeenCalledOnce()
    expect(onConnectAgent).toHaveBeenCalledOnce()
  })
})

describe('parseCommandLine', () => {
  it('splits a complete command without invoking a shell', () => {
    expect(parseCommandLine('npx -y "@company/context mcp" --stdio')).toEqual([
      'npx', '-y', '@company/context mcp', '--stdio',
    ])
    expect(parseCommandLine("node '/Users/person/My Server/server.mjs'")).toEqual([
      'node', '/Users/person/My Server/server.mjs',
    ])
  })

  it('rejects unfinished quoting instead of changing command meaning', () => {
    expect(() => parseCommandLine('npx "unfinished')).toThrow(/unfinished quote or escape/)
  })
})
