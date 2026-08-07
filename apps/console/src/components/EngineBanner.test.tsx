// @vitest-environment jsdom
// What the shell says when the local engine has stopped answering.
//
// This failure had no representation at all: the engine process stays alive,
// its port stays bound, and every request hangs — so the window kept its last
// paint and looked like an app nobody was using. The desktop shell measures it
// now; this is the half the user reads.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineBanner } from './EngineBanner'
import type { EngineHealth } from './EngineBanner'

let container: HTMLDivElement
let root: Root
let publish: ((state: EngineHealth) => void) | null = null
let unsubscribe: ReturnType<typeof vi.fn>
let relaunch: ReturnType<typeof vi.fn>

function health(patch: Partial<EngineHealth> = {}): EngineHealth {
  return { healthy: false, misses: 4, unresponsiveMs: 42_000, canRelaunch: false, ...patch }
}

/** Install the desktop bridge the way the preload does. */
function installBridge() {
  unsubscribe = vi.fn()
  relaunch = vi.fn().mockResolvedValue({ ok: true })
  window.__CC_DESKTOP = {
    engine: {
      onStatus: (cb: (state: EngineHealth) => void) => { publish = cb; return unsubscribe },
      relaunch,
    },
  } as unknown as typeof window.__CC_DESKTOP
}

const banner = () => container.querySelector<HTMLElement>('[role="status"]')
const text = () => (banner()?.textContent ?? '').replace(/\s+/g, ' ').trim()
const button = (label: string) => Array.from(container.querySelectorAll('button'))
  .find((b) => (b.textContent ?? '').includes(label))

async function send(state: EngineHealth) {
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

describe('the wedged-engine banner', () => {
  it('says nothing until the shell reports a problem', async () => {
    installBridge()
    await act(async () => root.render(<EngineBanner />))
    expect(banner()).toBeNull()

    await send(health({ healthy: true, misses: 0, unresponsiveMs: 0 }))
    expect(banner()).toBeNull()
  })

  it('names the likely cause rather than only the symptom', async () => {
    installBridge()
    await act(async () => root.render(<EngineBanner />))
    await send(health())
    expect(text()).toContain('The engine is busy — a large source may be indexing')
  })

  it('offers no restart until the shell says it is wedged rather than slow', async () => {
    installBridge()
    await act(async () => root.render(<EngineBanner />))
    await send(health({ canRelaunch: false }))
    expect(button('Restart Engine')).toBeUndefined()

    await send(health({ canRelaunch: true, unresponsiveMs: 64_000 }))
    expect(button('Restart Engine')).toBeDefined()
    // How long it has been stuck is the fact that justifies the offer.
    expect(text()).toContain('1m 04s')
  })

  it('restarts the engine through the desktop bridge, once', async () => {
    installBridge()
    await act(async () => root.render(<EngineBanner />))
    await send(health({ canRelaunch: true }))
    const restart = button('Restart Engine')
    await act(async () => { restart?.click() })
    await act(async () => { restart?.click() })
    expect(relaunch).toHaveBeenCalledTimes(1)
    expect(restart?.disabled).toBe(true)
  })

  it('clears when the engine answers again', async () => {
    installBridge()
    await act(async () => root.render(<EngineBanner />))
    await send(health({ canRelaunch: true }))
    expect(banner()).not.toBeNull()
    await send(health({ healthy: true, misses: 0, unresponsiveMs: 0, canRelaunch: false }))
    expect(banner()).toBeNull()
  })

  it('unsubscribes on unmount so a reload does not stack listeners', async () => {
    installBridge()
    await act(async () => root.render(<EngineBanner />))
    await act(async () => root.unmount())
    expect(unsubscribe).toHaveBeenCalled()
    // The afterEach unmount must stay safe.
    root = createRoot(container)
  })

  it('renders nothing, and throws nothing, in a plain browser', async () => {
    // No __CC_DESKTOP at all: the console ships to the web from this same build.
    await act(async () => root.render(<EngineBanner />))
    expect(banner()).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('survives a desktop build whose bridge predates the engine channel', async () => {
    window.__CC_DESKTOP = { version: '0.5.0' } as unknown as typeof window.__CC_DESKTOP
    await act(async () => root.render(<EngineBanner />))
    expect(banner()).toBeNull()
  })
})
