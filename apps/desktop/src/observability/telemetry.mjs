// Optional OTLP/HTTP JSON adapter. No SDK or runtime dependencies enter the core.
import { channel } from 'node:diagnostics_channel'
import fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
const CHANNEL = 'contextcake.diagnostics.v1'
const attr = (key, value) => ({
  key,
  value:
    typeof value === 'number'
      ? { doubleValue: value }
      : { stringValue: String(value) },
})
const nanos = (ms) => String(BigInt(Math.round(ms * 1e6)))
export function localEndpoint(value) {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' &&
      u.hostname === '127.0.0.1' &&
      u.port &&
      u.pathname === '/' &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
      ? u.origin
      : null
  } catch {
    return null
  }
}
export function createTelemetry({
  configPath,
  fetcher = fetch,
  intervalMs = 5000,
  capacity = 512,
  role = 'desktop',
} = {}) {
  if (!['desktop', 'mcp'].includes(role))
    throw new Error('INVALID_PROCESS_ROLE')
  let queue = [],
    busy = false,
    closed = false,
    dropped = 0,
    sent = 0,
    state = 'disabled',
    lastSuccessAt = null,
    deliveryFailures = 0
  let metricStart = Date.now(),
    historyGeneration = null
  const groups = new Map(),
    gauges = new Map(),
    delivered = new Set()
  const instanceId = randomBytes(8).toString('hex')
  // Cover the engine's two-hour maximum indexing budget, including deadline
  // overhead. Otherwise a multi-minute index quantile silently clamps to 30s.
  const bounds = [
    1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 30000, 60000, 120000, 300000,
    600000, 1800000, 3600000, 7200000, 10800000,
  ]
  const subscription = channel(CHANNEL)
  // Events come from the core's closed schema. Independently allowlist at export.
  const accept = (event) => {
    try {
      if (
        closed ||
        !['search', 'read', 'index', 'coverage', 'policy', 'export'].includes(
          event.operation,
        ) ||
        ![
          'ok',
          'error',
          'cancelled',
          'partial',
          'applied',
          'stale',
          'blocked',
        ].includes(event.outcome) ||
        !['desktop', 'mcp'].includes(event.role) ||
        !Number.isFinite(event.at) ||
        !Number.isFinite(event.durationMs) ||
        event.durationMs < 0
      )
        return
      if (queue.length >= capacity) {
        dropped++
        return
      }
      const safe = {}
      for (const k of [
        'operation',
        'outcome',
        'role',
        'at',
        'durationMs',
        'traceId',
        'spanId',
        'instanceId',
        'resultCount',
        'documentsRead',
        'documentsReused',
        'queueMs',
        'sourceCount',
        'incompleteSources',
      ])
        if (
          event[k] !== undefined &&
          (['operation', 'outcome', 'role'].includes(k) ||
            (['traceId', 'spanId', 'instanceId'].includes(k)
              ? new RegExp(`^[a-f0-9]{${k === 'traceId' ? 32 : 16}}$`).test(
                  event[k],
                )
              : Number.isFinite(event[k]) && event[k] >= 0))
        )
          safe[k] = event[k]
      if (
        [
          'OPERATION_FAILED',
          'CANCELLED',
          'INDEX_FAILED',
          'EXPORT_FAILED',
        ].includes(event.errorCode)
      )
        safe.errorCode = event.errorCode
      queue.push(safe)
    } catch {
      dropped++
    }
  }
  subscription.subscribe(accept)
  async function flush() {
    if (closed || busy) return
    busy = true
    try {
      let config
      try {
        config = JSON.parse(await fs.readFile(configPath, 'utf8'))
      } catch {
        config = { historyGeneration }
      }
      const generation =
        Number.isSafeInteger(config.historyGeneration) &&
        config.historyGeneration >= 0
          ? config.historyGeneration
          : 0
      if (historyGeneration !== null && generation !== historyGeneration) {
        dropped = 0
        sent = 0
        deliveryFailures = 0
        lastSuccessAt = null
        groups.clear()
        gauges.clear()
        delivered.clear()
        metricStart = Date.now()
      }
      if (generation !== historyGeneration && generation > 0) {
        const clearedAt = Number.isFinite(config.historyClearedAt)
          ? config.historyClearedAt
          : Date.now()
        const retained = queue.filter((event) => event.at > clearedAt)
        dropped += queue.length - retained.length
        queue = retained
      }
      historyGeneration = generation
      const endpoint = config.enabled && localEndpoint(config.endpoint)
      if (!endpoint) {
        if (config.enabled) dropped += queue.length
        queue = []
        state = config.enabled ? 'unavailable' : 'disabled'
        return
      }
      const batch = queue.splice(0, capacity)
      const resource = {
        attributes: [
          attr('service.name', 'contextcake'),
          attr('service.namespace', 'local'),
          attr('service.instance.id', instanceId),
        ],
      }
      const spans = batch
        .filter((e) => e.traceId && e.spanId)
        .map((e) => ({
          traceId: e.traceId,
          spanId: e.spanId,
          name: `contextcake.${e.operation}`,
          kind: 1,
          startTimeUnixNano: nanos(e.at - e.durationMs),
          endTimeUnixNano: nanos(e.at),
          status: { code: e.outcome === 'error' ? 2 : 1 },
          attributes: Object.entries(e)
            .filter(([k]) => !['at', 'traceId', 'spanId'].includes(k))
            .map(([k, v]) => attr(k, v)),
        }))
      const logs = batch.map((e) => ({
        timeUnixNano: nanos(e.at),
        observedTimeUnixNano: nanos(e.at),
        severityNumber: e.outcome === 'error' ? 17 : 9,
        severityText: e.outcome === 'error' ? 'ERROR' : 'INFO',
        body: { stringValue: `${e.operation}: ${e.outcome}` },
        traceId: e.traceId,
        spanId: e.spanId,
        attributes: [
          attr('role', e.role),
          attr('operation', e.operation),
          attr('outcome', e.outcome),
        ],
      }))
      for (const e of batch) {
        const key = `${e.operation}:${e.outcome}:${e.role}`
        let g = groups.get(key)
        if (!g) {
          g = {
            attributes: [
              attr('operation', e.operation),
              attr('outcome', e.outcome),
              attr('role', e.role),
            ],
            count: 0,
            sum: 0,
            buckets: Array(bounds.length + 1).fill(0),
            read: 0,
            reused: 0,
          }
          groups.set(key, g)
        }
        g.count++
        g.sum += e.durationMs
        const bucket = bounds.findIndex((b) => e.durationMs <= b)
        g.buckets[bucket < 0 ? bounds.length : bucket]++
        g.read += e.documentsRead ?? 0
        g.reused += e.documentsReused ?? 0
        for (const key of ['queueMs', 'sourceCount', 'incompleteSources'])
          if (e[key] !== undefined)
            gauges.set(`${key}:${e.role}`, { key, role: e.role, value: e[key] })
      }
      const stamp = {
        startTimeUnixNano: nanos(metricStart),
        timeUnixNano: nanos(Date.now()),
      }
      const metrics = [
        {
          name: 'contextcake.operations',
          sum: {
            aggregationTemporality: 2,
            isMonotonic: true,
            dataPoints: [...groups.values()].map((g) => ({
              ...stamp,
              attributes: g.attributes,
              asDouble: g.count,
            })),
          },
        },
        {
          name: 'contextcake.duration',
          unit: 'ms',
          histogram: {
            aggregationTemporality: 2,
            dataPoints: [...groups.values()].map((g) => ({
              ...stamp,
              attributes: g.attributes,
              count: String(g.count),
              sum: g.sum,
              explicitBounds: bounds,
              bucketCounts: g.buckets.map(String),
            })),
          },
        },
        ...['read', 'reused'].map((key) => ({
          name: `contextcake.documents.${key}`,
          sum: {
            aggregationTemporality: 2,
            isMonotonic: true,
            dataPoints: [...groups.values()].map((g) => ({
              ...stamp,
              attributes: g.attributes,
              asDouble: g[key],
            })),
          },
        })),
        ...['queueMs', 'sourceCount', 'incompleteSources'].map((key) => ({
          name: `contextcake.${key}`,
          gauge: {
            dataPoints: [...gauges.values()]
              .filter((g) => g.key === key)
              .map((g) => ({
                timeUnixNano: stamp.timeUnixNano,
                asDouble: g.value,
                attributes: [attr('role', g.role)],
              })),
          },
        })),
      ]
      metrics.push({
        name: 'contextcake.telemetry.failures',
        sum: {
          aggregationTemporality: 2,
          isMonotonic: true,
          dataPoints: [
            {
              ...stamp,
              attributes: [attr('role', role)],
              asDouble: deliveryFailures,
            },
          ],
        },
      })
      metrics.push({
        name: 'contextcake.telemetry.dropped',
        sum: {
          aggregationTemporality: 2,
          isMonotonic: true,
          dataPoints: [
            { ...stamp, attributes: [attr('role', role)], asDouble: dropped },
          ],
        },
      })
      // Prometheus rejects an entire OTLP request containing a metric with no
      // points. MCP processes have retrieval signals but no desktop gauges.
      const populatedMetrics = metrics.filter(
        (metric) =>
          (metric.sum ?? metric.gauge ?? metric.histogram).dataPoints.length >
          0,
      )
      const payloads = [
        [
          'traces',
          {
            resourceSpans: [
              { resource, scopeSpans: [{ scope: { name: CHANNEL }, spans }] },
            ],
          },
        ],
        [
          'logs',
          {
            resourceLogs: [
              {
                resource,
                scopeLogs: [{ scope: { name: CHANNEL }, logRecords: logs }],
              },
            ],
          },
        ],
        [
          'metrics',
          {
            resourceMetrics: [
              {
                resource,
                scopeMetrics: [
                  { scope: { name: CHANNEL }, metrics: populatedMetrics },
                ],
              },
            ],
          },
        ],
      ]
      const results = await Promise.all(
        payloads
          .map(async ([signal, body]) => {
            const response = await fetcher(`${endpoint}/v1/${signal}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
              redirect: 'error',
              signal: AbortSignal.timeout(2000),
            })
            if (!response.ok) throw new Error('EXPORT_FAILED')
            // A collector may accept only part of a batch with HTTP 200.
            const result = await response.json()
            if (
              result.partialSuccess &&
              Object.values(result.partialSuccess).some((v) => v && v !== '0')
            )
              throw new Error('EXPORT_PARTIAL')
          })
          .map((p) =>
            p.then(
              () => true,
              () => false,
            ),
          ),
      )
      if (results.every(Boolean)) {
        sent += batch.length
        lastSuccessAt = Date.now()
        state = 'ready'
        for (const e of batch) if (e.traceId) delivered.add(e.traceId)
        while (delivered.size > 512)
          delivered.delete(delivered.values().next().value)
      } else {
        dropped += batch.length
        deliveryFailures++
        state = 'unavailable'
      }
    } finally {
      busy = false
    }
  }
  const timer = setInterval(() => {
    void flush().catch(() => {
      state = 'unavailable'
    })
  }, intervalMs)
  timer.unref?.()
  return {
    flush,
    status: () => ({
      state,
      historyGeneration,
      dropped,
      sent,
      deliveryFailures,
      queued: queue.length,
      lastSuccessAt,
      exportedTraceIds: [...delivered],
    }),
    close() {
      closed = true
      clearInterval(timer)
      subscription.unsubscribe(accept)
      queue = []
    },
  }
}
