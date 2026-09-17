// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IntegrationsPanel } from './IntegrationsPanel'

let container: HTMLDivElement
let root: Root

function bridge(storage?: 'persistent' | 'memory') {
  window.__CC_INTEGRATIONS = {
    list: vi.fn().mockResolvedValue([]),
    addToken: vi.fn(),
    disconnect: vi.fn(),
    ...(storage ? { storage: vi.fn().mockResolvedValue({ mode: storage }) } : {}),
  }
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  delete window.__CC_INTEGRATIONS
})

const NOTICE = 'tokens you add here last only until ContextCake quits'

describe('IntegrationsPanel', () => {
  it('says when credentials will not survive a restart', async () => {
    bridge('memory')
    await act(async () => root.render(<IntegrationsPanel />))
    const status = Array.from(container.querySelectorAll('[role="status"]')).find((item) => item.textContent?.includes(NOTICE))
    expect(status?.textContent).toContain('No system keyring is available')
  })

  it('stays quiet when a keyring stores them, and with an app too old to say', async () => {
    bridge('persistent')
    await act(async () => root.render(<IntegrationsPanel />))
    expect(container.textContent).not.toContain(NOTICE)

    await act(async () => root.unmount())
    root = createRoot(container)
    bridge()
    await act(async () => root.render(<IntegrationsPanel />))
    expect(container.textContent).not.toContain(NOTICE)
    expect(container.textContent).toContain('Add a token')
  })
})
