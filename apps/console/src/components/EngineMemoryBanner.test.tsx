// @vitest-environment jsdom
// What the shell says when the engine's own memory watermark has gone
// critical (packages/core/src/memory-pressure.mjs), piggybacked on the same
// liveness ping the wedged-engine banner beside this one already relies on.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineMemoryBanner } from './EngineMemoryBanner'
import type { EngineMemory } from './EngineMemoryBanner'

let container: HTMLDivElement
let root: Root
let publish: ((state: EngineMemory) => void) | null = null
let unsubscribe: ReturnType<typeof vi.fn>

function installBridge() {
  unsubscribe = vi.fn()
  window.__CC_DESKTOP = {
    engine: {
      onMemory: (cb: (state: EngineMemory) => void) => { publish = cb; return unsubscribe },
    },
  } as unknown as typeof window.__CC_DESKTOP
}

const banner = () => container.querySelector<HTMLElement>('[role="status"]')
const text = () => (banner()?.textContent ?? '').replace(/\s+/g, ' ').trim()

async function send(state: EngineMemory) {
  await act(async () => { publish?.(state) })
}

beforeEach(async () => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  publish = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  delete window.__CC_DESKTOP
  vi.restoreAllMocks()
})

describe('the engine memory-pressure banner', () => {
  it('says nothing at normal or elevated pressure', async () => {
    installBridge()
    await act(async () => root.render(<EngineMemoryBanner />))
    expect(banner()).toBeNull()

    await send({ level: 'normal' })
    expect(banner()).toBeNull()

    // "elevated" is the threshold that slows new indexing passes, not one
    // worth interrupting the user over — see the comment in the component.
    await send({ level: 'elevated' })
    expect(banner()).toBeNull()
  })

  it('explains itself as paused, not broken, at critical pressure', async () => {
    installBridge()
    await act(async () => root.render(<EngineMemoryBanner />))
    await send({ level: 'critical' })
    expect(text()).toContain('paused starting new indexing passes')
  })

  it('clears once pressure drops back down', async () => {
    installBridge()
    await act(async () => root.render(<EngineMemoryBanner />))
    await send({ level: 'critical' })
    expect(banner()).not.toBeNull()
    await send({ level: 'normal' })
    expect(banner()).toBeNull()
  })

  it('renders nothing, and throws nothing, in a plain browser', async () => {
    await act(async () => root.render(<EngineMemoryBanner />))
    expect(banner()).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('survives a desktop build whose bridge predates this channel', async () => {
    window.__CC_DESKTOP = { engine: {} } as unknown as typeof window.__CC_DESKTOP
    await act(async () => root.render(<EngineMemoryBanner />))
    expect(banner()).toBeNull()
  })
})
