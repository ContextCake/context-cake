// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SetupWizard } from './SetupWizard'

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
    const path = container.querySelector<HTMLInputElement>('#wiz-personal-path')
    await act(async () => {
      if (!path) throw new Error('Personal path input missing')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(path, '/tmp/contextcake-personal')
      path.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('Next').click())
    await act(async () => button('Skip').click())
    await act(async () => button('Skip').click())
    await act(async () => button('Finish').click())

    expect(button('Connect an agent')).toBeTruthy()
    await act(async () => button('Connect an agent').click())
    expect(onClose).toHaveBeenCalledOnce()
    expect(onConnectAgent).toHaveBeenCalledOnce()
  })
})
