// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetUpdateCheckCache, checkForUpdate, isUpdateCheckEnabled, setUpdateCheckEnabled,
} from './update'

/** Mock a GET /releases list response (newest first, like GitHub). */
function mockReleases(releases: Array<Record<string, unknown>>) {
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => releases } as Response)
}

describe('checkForUpdate', () => {
  beforeEach(() => {
    __resetUpdateCheckCache()
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns update info when the newest console release is newer', async () => {
    mockReleases([
      { tag_name: 'console-v1.2.0', html_url: 'https://github.com/ContextCake/context-cake/releases/tag/console-v1.2.0' },
    ])

    const result = await checkForUpdate('1.1.0')
    expect(result).toEqual({ latest: '1.2.0', url: 'https://github.com/ContextCake/context-cake/releases/tag/console-v1.2.0' })
  })

  it('ignores engine v* releases — only the console-v* namespace counts', async () => {
    // Engine released more recently; the console update is older in the list.
    mockReleases([
      { tag_name: 'v9.0.0', html_url: 'https://example.com/v9.0.0' },
      { tag_name: 'console-v1.2.0', html_url: 'https://example.com/console-v1.2.0' },
    ])

    const result = await checkForUpdate('1.0.0')
    expect(result).toEqual({ latest: '1.2.0', url: 'https://example.com/console-v1.2.0' })
  })

  it('returns null when only engine releases exist', async () => {
    mockReleases([{ tag_name: 'v9.0.0', html_url: 'https://example.com/v9.0.0' }])

    await expect(checkForUpdate('0.1.0')).resolves.toBeNull()
  })

  it('skips draft and prerelease console releases', async () => {
    mockReleases([
      { tag_name: 'console-v3.0.0', html_url: 'https://example.com/3', draft: true },
      { tag_name: 'console-v2.0.0', html_url: 'https://example.com/2', prerelease: true },
      { tag_name: 'console-v1.2.0', html_url: 'https://example.com/1' },
    ])

    const result = await checkForUpdate('1.0.0')
    expect(result?.latest).toBe('1.2.0')
  })

  it('returns null when the newest console release equals the current version', async () => {
    mockReleases([{ tag_name: 'console-v1.0.0', html_url: 'https://example.com' }])

    await expect(checkForUpdate('1.0.0')).resolves.toBeNull()
  })

  it('returns null when the newest console release is older', async () => {
    mockReleases([{ tag_name: 'console-v0.9.0', html_url: 'https://example.com' }])

    await expect(checkForUpdate('1.0.0')).resolves.toBeNull()
  })

  it('compares multi-segment versions numerically, not lexically', async () => {
    // '1.9.0' < '1.10.0' numerically even though '9' > '1' lexically.
    mockReleases([{ tag_name: 'console-v1.10.0', html_url: 'https://example.com' }])

    const result = await checkForUpdate('1.9.0')
    expect(result?.latest).toBe('1.10.0')
  })

  it('falls back to a canonical release URL when html_url is missing', async () => {
    mockReleases([{ tag_name: 'console-v1.2.0' }])

    const result = await checkForUpdate('1.0.0')
    expect(result?.url).toBe('https://github.com/ContextCake/context-cake/releases/tag/console-v1.2.0')
  })

  it('never throws on a network error — resolves to null', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('network down'))

    await expect(checkForUpdate('1.0.0')).resolves.toBeNull()
  })

  it('never throws on a non-2xx status — resolves to null', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response)

    await expect(checkForUpdate('1.0.0')).resolves.toBeNull()
  })

  it('never throws on malformed JSON — resolves to null', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError('bad json') },
    } as unknown as Response)

    await expect(checkForUpdate('1.0.0')).resolves.toBeNull()
  })

  it('returns null on a non-array response body', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response)

    await expect(checkForUpdate('1.0.0')).resolves.toBeNull()
  })

  it('returns null on an empty release list', async () => {
    mockReleases([])

    await expect(checkForUpdate('1.0.0')).resolves.toBeNull()
  })

  it('session-caches the result — only fetches once across repeated calls', async () => {
    mockReleases([{ tag_name: 'console-v2.0.0', html_url: 'https://example.com' }])

    await checkForUpdate('1.0.0')
    await checkForUpdate('1.0.0')
    await checkForUpdate('1.0.0')

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('never retries after a failure — no retry loop', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('network down'))

    await checkForUpdate('1.0.0')
    await checkForUpdate('1.0.0')

    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('isUpdateCheckEnabled / setUpdateCheckEnabled', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('defaults on in live mode with no stored preference', () => {
    expect(isUpdateCheckEnabled('live')).toBe(true)
  })

  it('defaults off in demo mode with no stored preference', () => {
    expect(isUpdateCheckEnabled('demo')).toBe(false)
  })

  it('respects an explicit "off" override regardless of mode', () => {
    setUpdateCheckEnabled(false)
    expect(isUpdateCheckEnabled('live')).toBe(false)
    expect(isUpdateCheckEnabled('demo')).toBe(false)
  })

  it('respects an explicit "on" override regardless of mode', () => {
    setUpdateCheckEnabled(true)
    expect(isUpdateCheckEnabled('live')).toBe(true)
    expect(isUpdateCheckEnabled('demo')).toBe(true)
  })
})
