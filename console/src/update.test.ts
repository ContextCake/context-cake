// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetUpdateCheckCache, checkForUpdate, isUpdateCheckEnabled, setUpdateCheckEnabled,
} from './update'

describe('checkForUpdate', () => {
  beforeEach(() => {
    __resetUpdateCheckCache()
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns update info when the latest release is newer', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v1.2.0', html_url: 'https://github.com/ContextCake/context-cake/releases/tag/v1.2.0' }),
    } as Response)

    const result = await checkForUpdate('1.1.0')
    expect(result).toEqual({ latest: '1.2.0', url: 'https://github.com/ContextCake/context-cake/releases/tag/v1.2.0' })
  })

  it('strips a leading v from the tag', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v2.0.0', html_url: 'https://example.com/v2.0.0' }),
    } as Response)

    const result = await checkForUpdate('1.0.0')
    expect(result?.latest).toBe('2.0.0')
  })

  it('strips a non-numeric tag prefix like console-v (the real release scheme)', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'console-v1.2.0', html_url: 'https://example.com/console-v1.2.0' }),
    } as Response)

    const result = await checkForUpdate('0.1.0')
    expect(result?.latest).toBe('1.2.0')
  })

  it('returns null for a tag with no digits at all', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'latest', html_url: 'https://example.com/latest' }),
    } as Response)

    const result = await checkForUpdate('0.1.0')
    expect(result).toBeNull()
  })

  it('returns null when the latest release equals the current version', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v1.0.0', html_url: 'https://example.com' }),
    } as Response)

    const result = await checkForUpdate('1.0.0')
    expect(result).toBeNull()
  })

  it('returns null when the latest release is older', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v0.9.0', html_url: 'https://example.com' }),
    } as Response)

    const result = await checkForUpdate('1.0.0')
    expect(result).toBeNull()
  })

  it('compares multi-segment versions numerically, not lexically', async () => {
    // '1.9.0' < '1.10.0' numerically even though '9' > '1' lexically.
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v1.10.0', html_url: 'https://example.com' }),
    } as Response)

    const result = await checkForUpdate('1.9.0')
    expect(result?.latest).toBe('1.10.0')
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

  it('returns null when tag_name is missing', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response)

    await expect(checkForUpdate('1.0.0')).resolves.toBeNull()
  })

  it('session-caches the result — only fetches once across repeated calls', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v2.0.0', html_url: 'https://example.com' }),
    } as Response)

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
