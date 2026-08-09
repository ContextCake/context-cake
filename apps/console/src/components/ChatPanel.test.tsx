// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from './ChatPanel'

const mocks = vi.hoisted(() => ({ useStoreData: vi.fn(), useStoreChat: vi.fn() }))
vi.mock('../store', () => ({ useStoreData: mocks.useStoreData, useStoreChat: mocks.useStoreChat }))

let container: HTMLDivElement
let root: Root

function renderMode(mode: 'demo' | 'live', onConnectAgent?: () => void, onClose = vi.fn()) {
  mocks.useStoreData.mockReturnValue({ mode, setChatInput: vi.fn(), send: vi.fn() })
  mocks.useStoreChat.mockReturnValue({ chatMessages: [], chatBusy: false, chatInput: '' })
  return act(async () => root.render(<ChatPanel onClose={onClose} onConnectAgent={onConnectAgent} />))
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  delete window.claude
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  delete window.claude
})

describe('Ask ContextCake capability states', () => {
  it('does not offer canned answers or a fake config command in unconnected live mode', async () => {
    await renderMode('live')

    expect(container.textContent).toContain('Connect an agent for live answers')
    expect(container.textContent).toContain('Open the connection guide')
    expect(container.querySelector('textarea')).toBeNull()
    expect(container.textContent).not.toContain('What database do we use?')
    expect(container.textContent).not.toContain('Copy MCP config')
  })

  it('labels demo answers as samples and keeps the sample composer available', async () => {
    await renderMode('demo')

    expect(container.textContent).toContain('Sample answers from the demo cascade')
    expect(container.textContent).toContain('Try the demo cascade')
    expect(container.querySelector('textarea')).toBeTruthy()
    expect(container.textContent).toContain('What database do we use?')
  })

  it('opens the desktop connection flow from the live empty state', async () => {
    const onConnectAgent = vi.fn()
    const onClose = vi.fn()
    await renderMode('live', onConnectAgent, onClose)

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter((button) => button.textContent === 'Connect an agent')
    await act(async () => buttons[buttons.length - 1]?.click())
    expect(onClose).toHaveBeenCalledOnce()
    expect(onConnectAgent).toHaveBeenCalledOnce()
  })
})
