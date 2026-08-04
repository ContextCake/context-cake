// Privacy-light install measurement using the same pinned GitHub Releases host
// as app downloads and updates. A successful first packaged launch fetches one
// tiny release asset, then leaves a local marker so the request is never
// repeated for this ContextCake data directory. No identifier, account data,
// knowledge content, path, or event body is sent.
import fs from 'node:fs'
import path from 'node:path'

export const INSTALL_METRIC_ASSET = 'install-ping.txt'
export const INSTALL_METRIC_MARKER = 'install-metric-v1.json'

export function installMetricUrl(version) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('Invalid ContextCake version for install metric.')
  }
  return `https://github.com/ContextCake/context-cake/releases/download/app-v${version}/${INSTALL_METRIC_ASSET}`
}

export async function reportFirstLaunch({
  isPackaged,
  version,
  configDir,
  metricsEnabled = false,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = 5_000,
}) {
  if (!isPackaged) return { status: 'development' }
  if (!metricsEnabled) return { status: 'disabled' }

  const marker = path.join(configDir, INSTALL_METRIC_MARKER)
  if (fs.existsSync(marker)) return { status: 'already-reported' }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()

  try {
    const response = await fetchImpl(installMetricUrl(version), {
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
    return { status: 'failed' }
  } finally {
    clearTimeout(timeout)
  }
}
