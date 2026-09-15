import { localEndpoint } from './telemetry.mjs'

// Renderer callers choose a known view, never supply a URL or a host.
export function grafanaLocation(
  origin,
  { traceId, range = 'now-15m', theme = 'light' } = {},
) {
  const base = localEndpoint(origin)
  if (
    !base ||
    !['now-15m', 'now-1h', 'now-24h'].includes(range) ||
    !['light', 'dark'].includes(theme) ||
    (traceId !== undefined && !/^[a-f0-9]{32}$/.test(traceId))
  )
    throw new Error('INVALID_GRAFANA_VIEW')
  const route = traceId
    ? `/d/contextcake-trace/trace?var-traceId=${traceId}`
    : '/d/contextcake/contextcake?view=dashboard'
  return `${base}${route}&theme=${theme}&from=${range}&to=now`
}
