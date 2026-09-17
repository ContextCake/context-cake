// Privacy-light install measurement using the same pinned GitHub Releases host
// as app downloads and updates. A successful first packaged launch fetches one
// tiny release asset, then leaves a local marker so the request is never
// repeated for this ContextCake data directory. No identifier, account data,
// knowledge content, path, or event body is sent.
//
// Each platform build fetches its own asset, so Intel and Apple silicon
// launches count separately. The asset names mirror the pingAsset column of
// scripts/release-platforms.mjs, which the packaged app cannot import;
// scripts/tests/release-platforms.test.mjs fails if the two drift.
import fs from 'node:fs'
import path from 'node:path'

export const INSTALL_METRIC_MARKER = 'install-metric-v1.json'
const inFlightByMarker = new Map()
const OS_BY_PLATFORM = { darwin: 'mac', linux: 'linux' }

export function installMetricAsset({ platform = process.platform, arch = process.arch, packageType } = {}) {
  const os = OS_BY_PLATFORM[platform]
  if (!os) return null
  return `install-ping-${[os, arch, packageType].filter(Boolean).join('-')}.txt`
}

export function installMetricUrl(version, asset) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('Invalid ContextCake version for install metric.')
  }
  if (!/^install-ping-[a-z0-9-]+\.txt$/.test(asset ?? '')) {
    throw new Error('Invalid install metric asset.')
  }
  return `https://github.com/ContextCake/context-cake/releases/download/app-v${version}/${asset}`
}

export async function reportFirstLaunch({
  isPackaged,
  version,
  configDir,
  metricsEnabled = false,
  platform = process.platform,
  arch = process.arch,
  packageType,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = 5_000,
  signal,
}) {
  if (!isPackaged) return { status: 'development' }
  if (!metricsEnabled) return { status: 'disabled' }
  const asset = installMetricAsset({ platform, arch, packageType })
  if (!asset) return { status: 'unsupported' }

  const marker = path.join(configDir, INSTALL_METRIC_MARKER)
  if (fs.existsSync(marker)) return { status: 'already-reported' }
  if (inFlightByMarker.has(marker)) return inFlightByMarker.get(marker)

  const request = (async () => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(abort, timeoutMs)
    timeout.unref?.()

    try {
      const response = await fetchImpl(installMetricUrl(version, asset), {
        method: 'GET',
        redirect: 'follow',
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!response.ok) return { status: 'failed', httpStatus: response.status }
      // Consume the tiny asset completely so GitHub records an actual download,
      // not merely a redirect/response whose body the client abandoned.
      await response.arrayBuffer()

      fs.mkdirSync(configDir, { recursive: true })
      const temporary = `${marker}.tmp`
      fs.writeFileSync(temporary, JSON.stringify({
        reportedAt: now().toISOString(),
        version,
      }, null, 2) + '\n', { mode: 0o600 })
      fs.renameSync(temporary, marker)
      return { status: 'reported' }
    } catch {
      // Metrics must never interrupt startup or turn a network failure into an
      // app error. With no marker, the next launch may try once more.
      return { status: signal?.aborted ? 'cancelled' : 'failed' }
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  })()

  inFlightByMarker.set(marker, request)
  try {
    return await request
  } finally {
    if (inFlightByMarker.get(marker) === request) inFlightByMarker.delete(marker)
  }
}
