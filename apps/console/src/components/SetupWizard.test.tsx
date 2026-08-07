// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveSourceName, parseCommandLine, SetupWizard } from './SetupWizard'

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), reload: vi.fn() }))

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  apiFetch: mocks.apiFetch,
}))
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

function postCalls(): Array<Record<string, unknown>> {
  return mocks.apiFetch.mock.calls
    .filter(([url, init]) => url === '/api/sources' && (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
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

describe('SetupWizard first run', () => {
  it('adds a repository, vault, or wiki folder as the Markdown source users expect', async () => {
    await act(async () => root.render(<SetupWizard onClose={vi.fn()} />))

    await act(async () => button('Get started').click())
    expect(container.textContent).toContain('Recommended for repository docs, an Obsidian vault, or a Markdown wiki')
    expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain('Markdown folder')
    await enter('#wiz-personal-path', '/tmp/work-vault')
    await act(async () => button('Next').click())

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/sources', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ kind: 'files', name: 'work-vault', level: 3, path: '/tmp/work-vault' }),
    }))
  })

  it('derives the source name from the folder basename but keeps it editable', async () => {
    await act(async () => root.render(<SetupWizard onClose={vi.fn()} />))

    await act(async () => button('Get started').click())
    await enter('#wiz-personal-path', '/Users/person/Work Vault')
    expect(container.querySelector<HTMLInputElement>('#wiz-personal-name')?.value).toBe('Work Vault')

    await enter('#wiz-personal-name', 'My notes')
    await enter('#wiz-personal-path', '/Users/person/Other Folder')
    // The user's own name is never clobbered by a later path change.
    expect(container.querySelector<HTMLInputElement>('#wiz-personal-name')?.value).toBe('My notes')

    await act(async () => button('Next').click())
    expect(postCalls()[0]).toMatchObject({ name: 'My notes', level: 3 })
  })

  it('lets the level stepper change precedence away from the 3/2/0 defaults', async () => {
    await act(async () => root.render(<SetupWizard onClose={vi.fn()} />))

    await act(async () => button('Get started').click())
    expect(container.querySelector('#wiz-personal-level')?.textContent).toBe('3')
    await enter('#wiz-personal-path', '/tmp/vault')
    const lower = container.querySelector<HTMLButtonElement>('button[aria-label="Lower level"]')
    await act(async () => lower?.click())
    expect(container.querySelector('#wiz-personal-level')?.textContent).toBe('2')
    await act(async () => button('Next').click())

    expect(postCalls()[0]).toMatchObject({ level: 2 })
  })

  it('makes the structured ContextCake option deliberate rather than the default', async () => {
    await act(async () => root.render(<SetupWizard onClose={vi.fn()} />))

    await act(async () => button('Get started').click())
    await act(async () => sourceChoice('ContextCake folder').click())
    await enter('#wiz-personal-path', '/tmp/structured-context')
    await act(async () => button('Next').click())

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/sources', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ kind: 'local', name: 'structured-context', level: 3, path: '/tmp/structured-context' }),
    }))
  })

  it('sends a public team repo through the clone-free github-rest kind with no follow-up sync', async () => {
    await act(async () => root.render(<SetupWizard onClose={vi.fn()} />))

    await act(async () => button('Get started').click())
    await enter('#wiz-personal-path', '/tmp/vault')
    await act(async () => button('Next').click())

    await act(async () => button('GitHub repo').click())
    expect(sourceChoice('Public repo (no clone)').getAttribute('aria-checked')).toBe('true')
    await enter('#wiz-team-repo', 'acme/payments-docs')
    expect(container.querySelector<HTMLInputElement>('#wiz-team-name')?.value).toBe('payments-docs')
    await act(async () => button('Next').click())

    expect(postCalls()[1]).toEqual({ kind: 'github-rest', name: 'payments-docs', level: 2, repo: 'acme/payments-docs' })
    // Add is atomic — the old post-add sync call created half-added layers.
    const syncCalls = mocks.apiFetch.mock.calls.filter(([url]) => String(url).startsWith('/api/sources/sync'))
    expect(syncCalls).toHaveLength(0)
  })

  it('sends a private team repo through the existing github clone kind', async () => {
    await act(async () => root.render(<SetupWizard onClose={vi.fn()} />))

    await act(async () => button('Get started').click())
    await enter('#wiz-personal-path', '/tmp/vault')
    await act(async () => button('Next').click())

    await act(async () => button('GitHub repo').click())
    await act(async () => sourceChoice('Private repo').click())
    await enter('#wiz-team-repo', 'acme/internal-docs')
    await act(async () => button('Next').click())

    expect(postCalls()[1]).toEqual({ kind: 'github', name: 'internal-docs', level: 2, repo: 'acme/internal-docs' })
  })

  it('surfaces a duplicate-name 409 inline instead of advancing', async () => {
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/sources' && init?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'A source named "team" already exists' }), {
          status: 409, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    await act(async () => root.render(<SetupWizard onClose={vi.fn()} />))

    await act(async () => button('Get started').click())
    await enter('#wiz-personal-path', '/tmp/team')
    await act(async () => button('Next').click())

    expect(container.textContent).toContain('A source named "team" already exists')
    expect(container.querySelector('#wiz-personal-path')).toBeTruthy()
  })

  it('treats a 409 on an identical retry as success — the earlier add landed', async () => {
    let calls = 0
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/sources' && init?.method === 'POST') {
        calls += 1
        if (calls === 1) throw new DOMException('The operation timed out', 'TimeoutError')
        return new Response(JSON.stringify({ error: 'A source named "vault" already exists' }), {
          status: 409, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    await act(async () => root.render(<SetupWizard onClose={vi.fn()} />))

    await act(async () => button('Get started').click())
    await enter('#wiz-personal-path', '/tmp/vault')
    await act(async () => button('Next').click())
    // First attempt failed in flight; the wizard stays put and says so.
    expect(container.querySelector('#wiz-personal-path')).toBeTruthy()

    await act(async () => button('Next').click())
    // Retry got 409 because the first attempt actually landed → proceed.
    expect(container.querySelector('#wiz-personal-path')).toBeNull()
    expect(container.textContent).toContain('Add a team source')
  })

  // The confirmation the flow never had. "Source added" used to follow from the
  // POST alone: a lost response was assumed to have landed, and a source that
  // never appeared still got a success screen.
  it('checks the cascade before reporting a lost POST as success', async () => {
    const statusSources: Array<{ name: string }> = []
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/sources' && init?.method === 'POST') {
        // It landed server-side; only the response was lost.
        statusSources.push({ name: 'vault' })
        throw new DOMException('The operation timed out', 'TimeoutError')
      }
      if (url === '/api/status') {
        return new Response(JSON.stringify({ generation: 1, indexing: false, indexingSources: [], sources: statusSources }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    await act(async () => root.render(<SetupWizard onClose={vi.fn()} />))

    await act(async () => button('Get started').click())
    await enter('#wiz-personal-path', '/tmp/vault')
    await act(async () => button('Next').click())

    // The engine says the source is there, so the add did what the user asked.
    expect(container.querySelector('#wiz-personal-path')).toBeNull()
    expect(container.textContent).toContain('Add a team source')
  })

  it('refuses to report success for a source that never appeared', async () => {
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/sources' && init?.method === 'POST') {
        throw new DOMException('The operation timed out', 'TimeoutError')
      }
      if (url === '/api/status') {
        // The engine is answering, and this source is not in it.
        return new Response(JSON.stringify({ generation: 1, indexing: false, indexingSources: [], sources: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    await act(async () => root.render(<SetupWizard onClose={vi.fn()} />))

    await act(async () => button('Get started').click())
    await enter('#wiz-personal-path', '/tmp/vault')
    await act(async () => {
      button('Next').click()
      // The landed check polls the cheap route a few times before concluding.
      await new Promise((resolve) => setTimeout(resolve, 1_500))
    })

    expect(container.querySelector('#wiz-personal-path')).toBeTruthy()
    expect(container.textContent).toContain('is not in the cascade, so nothing was added')
  })

  it('still calls a first-attempt 409 a real clash when the name was already there', async () => {
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/sources' && init?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'A source named "vault" already exists' }), {
          status: 409, headers: { 'content-type': 'application/json' },
        })
      }
      if (url === '/api/status') {
        return new Response(JSON.stringify({ generation: 1, indexing: false, indexingSources: [], sources: [{ name: 'vault' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    await act(async () => root.render(<SetupWizard onClose={vi.fn()} />))

    await act(async () => button('Get started').click())
    await enter('#wiz-personal-path', '/tmp/vault')
    await act(async () => button('Next').click())

    expect(container.textContent).toContain('A source named "vault" already exists')
    expect(container.querySelector('#wiz-personal-path')).toBeTruthy()
  })

  it('reports each added source\'s live engine status on the success step', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/status') {
        return new Response(JSON.stringify({
          generation: 3, indexing: true, indexingSources: ['vault'],
          sources: [{ name: 'vault', level: 3, kind: 'files', status: 'indexing', phase: 'loading', loaded: 1240, total: 3000, conceptCount: 0, refreshing: false, error: null }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify(url === '/api/graph' ? { concepts: [] } : {}), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    })
    await act(async () => root.render(<SetupWizard addingSource onClose={vi.fn()} />))

    await enter('#wiz-add-path', '/tmp/vault')
    await act(async () => button('Add source').click())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })

    expect(container.textContent).toContain('Source added')
    expect(container.textContent).toContain('Reading — 1,240 / 3,000')
    // Done is available while the source is still being read.
    expect(button('Done').disabled).toBe(false)
  })

  // A ticking counter inside a polite live region is read out on every tick.
  // App.tsx states the doctrine — announce transitions, not ticks — and the
  // activity popover already follows it; this line did not.
  it('reports index progress as a progressbar, not something announced every tick', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/status') {
        return new Response(JSON.stringify({
          generation: 3, indexing: true, indexingSources: ['vault'],
          sources: [{ name: 'vault', level: 3, kind: 'files', status: 'indexing', phase: 'loading', loaded: 1240, total: 3000, conceptCount: 0, refreshing: false, error: null }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify(url === '/api/graph' ? { concepts: [] } : {}), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    })
    await act(async () => root.render(<SetupWizard addingSource onClose={vi.fn()} />))

    await enter('#wiz-add-path', '/tmp/vault')
    await act(async () => button('Add source').click())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })

    const bar = container.querySelector('[role="progressbar"]')
    expect(bar?.textContent).toContain('1,240 / 3,000')
    expect(bar?.getAttribute('aria-valuetext')).toContain('1,240 / 3,000')
    expect(bar?.getAttribute('aria-valuenow')).toBe('41')
    // And it is not also a live region.
    expect(Array.from(container.querySelectorAll('[role="status"]')).map((n) => n.textContent ?? '').join(' '))
      .not.toContain('1,240 / 3,000')
  })

  // fetchStatus answers null for a 404, a 500, a socket error and a timeout
  // alike. Treating all four as "this engine has no status route" meant one
  // blip three seconds into a 3,000-note index retired these cards for good,
  // while the source was still reading.
  it('keeps watching a source through a failed status request', async () => {
    let calls = 0
    let blipped = false
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/status') {
        calls += 1
        // One 500, once the card has had a tick to show progress. Everything
        // after it is the answer the watcher would have had all along.
        if (calls === 3 && !blipped) {
          blipped = true
          return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
        }
        const answer = blipped
          ? { status: 'ok', phase: 'ready', loaded: 3000, total: 3000, conceptCount: 3000 }
          : { status: 'indexing', phase: 'loading', loaded: 1240, total: 3000, conceptCount: 0 }
        return new Response(JSON.stringify({
          generation: 3, indexing: answer.status === 'indexing', indexingSources: [],
          sources: [{ name: 'vault', level: 3, kind: 'files', refreshing: false, error: null, ...answer }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify(url === '/api/graph' ? { concepts: [] } : {}), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    })
    await act(async () => root.render(<SetupWizard addingSource onClose={vi.fn()} />))

    await enter('#wiz-add-path', '/tmp/vault')
    await act(async () => button('Add source').click())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    expect(container.textContent).toContain('Reading — 1,240 / 3,000')

    // Two more 900ms ticks: the blip, then the answer that was waiting behind it.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_100)) })
    expect(container.textContent).toContain('Ready · 3000 concepts')
  })

  it('surfaces server-side folder validation inline at the add step', async () => {
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/sources' && init?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'Folder not found: /tmp/nope' }), {
          status: 400, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    await act(async () => root.render(<SetupWizard onClose={vi.fn()} />))

    await act(async () => button('Get started').click())
    await enter('#wiz-personal-path', '/tmp/nope')
    await act(async () => button('Next').click())

    expect(container.textContent).toContain('Folder not found: /tmp/nope')
    // Still on the add step — the wizard must not advance past a rejected source.
    expect(container.querySelector('#wiz-personal-path')).toBeTruthy()
  })

  it('warns on the review step when a folder holds no documents', async () => {
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => new Response(
      JSON.stringify(url === '/api/sources' && init?.method === 'POST'
        ? { ok: true, added: 'empty-vault', indexing: true, hasDocuments: false, scanComplete: true }
        : {}),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    await act(async () => root.render(<SetupWizard onClose={vi.fn()} />))

    await act(async () => button('Get started').click())
    await enter('#wiz-personal-path', '/tmp/empty-vault')
    await act(async () => button('Next').click())
    await act(async () => button('Skip').click())
    await act(async () => button('Skip for now').click())

    expect(container.textContent).toContain('no documents found')
  })

  it('says indexing continues in the background rather than blocking setup', async () => {
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => new Response(
      JSON.stringify(url === '/api/sources' && init?.method === 'POST'
        ? { ok: true, added: 'work-vault', indexing: true, hasDocuments: true, scanComplete: true }
        : { concepts: [{ id: 'systems/app' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    await act(async () => root.render(<SetupWizard onClose={vi.fn()} />))

    await act(async () => button('Get started').click())
    await enter('#wiz-personal-path', '/tmp/work-vault')
    await act(async () => button('Next').click())
    await act(async () => button('Skip').click())
    await act(async () => button('Skip for now').click())

    expect(container.textContent).toContain('indexing in the background')
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

  it('carries the explicit trust acknowledgement to the command-executing API', async () => {
    await act(async () => root.render(<SetupWizard onClose={vi.fn()} />))
    await act(async () => button('Get started').click())
    await enter('#wiz-personal-path', '/tmp/contextcake-personal')
    await act(async () => button('Next').click())
    await act(async () => button('Skip').click())
    await act(async () => button('Connect an MCP server').click())
    await enter('#wiz-mcp-command', 'npx -y @company/context-mcp')
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click())
    await act(async () => button('Connect server').click())

    const call = postCalls().find((body) => body.kind === 'mcp')
    expect(call).toMatchObject({
      kind: 'mcp', name: 'context-mcp', level: 0, command: 'npx', args: ['-y', '@company/context-mcp'], trusted: true,
    })
  })

  it('uses the native folder browser when the desktop bridge is available', async () => {
    const chooseFolder = vi.fn().mockResolvedValue('/Users/person/ContextCake/personal')
    window.__CC_DESKTOP = {
      getApiToken: async () => 'test',
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
    expect(container.querySelector<HTMLInputElement>('#wiz-personal-name')?.value).toBe('personal')
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

  it('survives the shell flipping addingSource mid-flow once the first source lands', async () => {
    // App passes addingSource={sources.length > 0}, which flips true the
    // moment reload() picks up the source added at step 2. The wizard's step
    // machine is frozen at mount — the flip must not blank the dialog.
    await act(async () => root.render(<SetupWizard addingSource={false} onClose={vi.fn()} />))

    await act(async () => button('Get started').click())
    await enter('#wiz-personal-path', '/tmp/work-vault')
    await act(async () => button('Next').click())
    await act(async () => root.render(<SetupWizard addingSource={true} onClose={vi.fn()} />))

    expect(container.textContent).toContain('Add a team source')
    await act(async () => button('Skip').click())
    await act(async () => button('Skip for now').click())
    await act(async () => button('Finish').click())
    expect(container.textContent).toContain("You're set up")
  })

  it('does not tell users to add content while their source is still indexing', async () => {
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => new Response(
      JSON.stringify(url === '/api/sources' && init?.method === 'POST'
        ? { ok: true, added: 'contextcake-personal', indexing: true, hasDocuments: true, scanComplete: true }
        : { concepts: [], indexing: true, indexingSources: ['contextcake-personal'] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    await act(async () => root.render(<SetupWizard onClose={vi.fn()} />))

    await act(async () => button('Get started').click())
    await enter('#wiz-personal-path', '/tmp/contextcake-personal')
    await act(async () => button('Next').click())
    await act(async () => button('Skip').click())
    await act(async () => button('Skip for now').click())
    await act(async () => button('Finish').click())

    expect(container.textContent).toContain('still indexing in the background')
    expect(container.textContent).not.toContain('Add content to a layer')
  })
})

describe('SetupWizard add-a-source mode', () => {
  it('collapses to one step with a four-kind picker and per-kind level defaults', async () => {
    await act(async () => root.render(<SetupWizard addingSource onClose={vi.fn()} />))

    // No welcome detour — the form IS the first screen.
    expect(container.textContent).toContain('Add a source')
    for (const label of ['Markdown folder', 'ContextCake folder', 'GitHub repo', 'MCP server']) {
      expect(sourceChoice(label)).toBeTruthy()
    }
    expect(container.querySelector('#wiz-add-level')?.textContent).toBe('3')

    await act(async () => sourceChoice('GitHub repo').click())
    expect(container.querySelector('#wiz-add-level')?.textContent).toBe('2')
    await act(async () => sourceChoice('MCP server').click())
    expect(container.querySelector('#wiz-add-level')?.textContent).toBe('0')
    await act(async () => sourceChoice('Markdown folder').click())
    expect(container.querySelector('#wiz-add-level')?.textContent).toBe('3')
  })

  it('accepts a second repo beside team under its own name (EARS)', async () => {
    await act(async () => root.render(<SetupWizard addingSource onClose={vi.fn()} />))

    await act(async () => sourceChoice('GitHub repo').click())
    await enter('#wiz-add-repo', 'acme/design-system')
    expect(container.querySelector<HTMLInputElement>('#wiz-add-name')?.value).toBe('design-system')
    await act(async () => button('Add source').click())

    expect(postCalls()[0]).toEqual({ kind: 'github-rest', name: 'design-system', level: 2, repo: 'acme/design-system' })
    expect(container.textContent).toContain('Source added')
  })

  it('accepts a second MCP server under a distinct name with the trust gate intact (EARS)', async () => {
    await act(async () => root.render(<SetupWizard addingSource onClose={vi.fn()} />))

    await act(async () => sourceChoice('MCP server').click())
    await enter('#wiz-add-command', 'npx -y @acme/design-graph-mcp')
    // The trust checkbox survives in add mode: no consent, no submit.
    expect(button('Add source').disabled).toBe(true)
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click())
    await act(async () => button('Add source').click())

    expect(postCalls()[0]).toMatchObject({
      kind: 'mcp', name: 'design-graph-mcp', level: 0, command: 'npx', args: ['-y', '@acme/design-graph-mcp'], trusted: true,
    })
    expect(container.textContent).toContain('Source added')
  })

  it('requires a name when the user clears the derived one', async () => {
    await act(async () => root.render(<SetupWizard addingSource onClose={vi.fn()} />))

    await enter('#wiz-add-path', '/tmp/repo-b')
    await enter('#wiz-add-name', '')
    await act(async () => button('Add source').click())

    expect(container.textContent).toContain('Give this source a short name')
    expect(postCalls()).toHaveLength(0)
  })

  it('sends a private repo through the clone kind in add mode too', async () => {
    await act(async () => root.render(<SetupWizard addingSource onClose={vi.fn()} />))

    await act(async () => sourceChoice('GitHub repo').click())
    await act(async () => sourceChoice('Private repo').click())
    await enter('#wiz-add-repo', 'acme/secret-docs')
    await act(async () => button('Add source').click())

    expect(postCalls()[0]).toEqual({ kind: 'github', name: 'secret-docs', level: 2, repo: 'acme/secret-docs' })
  })
})

describe('deriveSourceName', () => {
  it('derives folder names from the basename', () => {
    expect(deriveSourceName({ kind: 'files', path: '/Users/person/Work Vault/' })).toBe('Work Vault')
    expect(deriveSourceName({ kind: 'local', path: '/tmp/notes.d' })).toBe('notes-d')
  })

  it('derives repo names from the slug', () => {
    expect(deriveSourceName({ kind: 'github', repo: 'acme/payments-docs' })).toBe('payments-docs')
    expect(deriveSourceName({ kind: 'github', repo: 'acme/payments-docs.git' })).toBe('payments-docs')
  })

  it('derives MCP names from the command target, not the runner', () => {
    expect(deriveSourceName({ kind: 'mcp', command: 'npx -y @acme/context-mcp' })).toBe('context-mcp')
    expect(deriveSourceName({ kind: 'mcp', command: 'node /opt/acme/server.mjs' })).toBe('server')
    expect(deriveSourceName({ kind: 'mcp', command: '/opt/bin/acme-graph --stdio' })).toBe('acme-graph')
  })

  it('returns empty rather than guessing on an unparsable command', () => {
    expect(deriveSourceName({ kind: 'mcp', command: 'npx "unfinished' })).toBe('')
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
