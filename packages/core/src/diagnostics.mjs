import { channel } from 'node:diagnostics_channel';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const DIAGNOSTICS_CHANNEL = 'contextcake.diagnostics.v1';
const events = channel(DIAGNOSTICS_CHANNEL);
const OPERATIONS = new Set([
  'search',
  'read',
  'index',
  'coverage',
  'policy',
  'export',
]);
const OUTCOMES = new Set([
  'ok',
  'error',
  'cancelled',
  'partial',
  'applied',
  'stale',
  'blocked',
]);
const ERROR_CODES = new Set([
  'OPERATION_FAILED',
  'CANCELLED',
  'INDEX_FAILED',
  'EXPORT_FAILED',
]);
const COUNTS = [
  'resultCount',
  'documentsRead',
  'documentsReused',
  'queueMs',
  'sourceCount',
  'incompleteSources',
  'dropped',
  'candidateCount',
  'storeSyncMs',
  'decodedRecords',
];
// Retrieval-backend phase and storage kind — bounded enums, same discipline
// as `role`. `phase` only carries meaning on a `search` event (cold: this
// search caused documents to be analyzed/decoded; warm: it answered from an
// already-current index/store).
const PHASES = new Set(['cold', 'warm']);
const BACKENDS = new Set(['sqlite', 'memory']);

// Closed fields and enums, not a redactor applied to arbitrary source text.
export function safeEvent(input) {
  if (!OPERATIONS.has(input.operation)) return null;
  const event = {
    operation: input.operation,
    outcome: OUTCOMES.has(input.outcome) ? input.outcome : 'error',
    role: input.role === 'mcp' ? 'mcp' : 'desktop',
    at: Number.isFinite(input.at) ? input.at : Date.now(),
    durationMs: Math.max(
      0,
      Number.isFinite(input.durationMs) ? input.durationMs : 0,
    ),
  };
  if (ERROR_CODES.has(input.errorCode)) event.errorCode = input.errorCode;
  for (const key of COUNTS)
    if (Number.isFinite(input[key]) && input[key] >= 0)
      event[key] = Math.min(input[key], Number.MAX_SAFE_INTEGER);
  if (event.operation === 'search' && PHASES.has(input.phase))
    event.phase = input.phase;
  if (BACKENDS.has(input.backend)) event.backend = input.backend;
  for (const [key, size] of [
    ['traceId', 32],
    ['spanId', 16],
    ['instanceId', 16],
  ]) {
    if (
      typeof input[key] === 'string' &&
      new RegExp(`^[a-f0-9]{${size}}$`).test(input[key])
    )
      event[key] = input[key];
  }
  return event;
}

export function createDiagnostics({
  role = 'desktop',
  limit = 200,
  windowMs = 900_000,
} = {}) {
  const startedAt = Date.now();
  const instanceId = randomBytes(8).toString('hex');
  const recent = [];
  function record(input) {
    const event = safeEvent({
      ...input,
      role,
      instanceId,
      at: Date.now(),
      traceId: input.traceId ?? randomBytes(16).toString('hex'),
      spanId: randomBytes(8).toString('hex'),
    });
    if (!event) return;
    recent.push(event);
    if (recent.length > limit) recent.splice(0, recent.length - limit);
    events.publish(event);
    return event;
  }
  // Filters an annotate() callback's return value through the same closed
  // schema as any other event, then strips the fields record() itself always
  // supplies (operation/outcome/role/at/durationMs/traceId/spanId/instanceId)
  // so an annotation can only ever ADD bounded fields (phase, backend,
  // candidateCount, ...), never override identity/timing.
  function filterAnnotation(operation, raw) {
    if (!raw || typeof raw !== 'object') return {};
    const filtered = safeEvent({ operation, outcome: 'ok', role, ...raw });
    if (!filtered) return {};
    const {
      operation: _operation,
      outcome: _outcome,
      role: _role,
      at: _at,
      durationMs: _durationMs,
      traceId: _traceId,
      spanId: _spanId,
      instanceId: _instanceId,
      ...rest
    } = filtered;
    return rest;
  }
  async function measure(operation, action, { annotate } = {}) {
    const start = performance.now();
    try {
      const result = await action();
      const extra =
        typeof annotate === 'function'
          ? filterAnnotation(operation, annotate(result))
          : {};
      record({
        operation,
        outcome: result?.indexing ? 'partial' : 'ok',
        durationMs: performance.now() - start,
        resultCount: Array.isArray(result)
          ? result.length
          : (result?.hits?.length ?? (result ? 1 : 0)),
        ...extra,
      });
      return result;
    } catch (error) {
      record({
        operation,
        outcome: error?.name === 'AbortError' ? 'cancelled' : 'error',
        durationMs: performance.now() - start,
        errorCode:
          error?.name === 'AbortError' ? 'CANCELLED' : 'OPERATION_FAILED',
      });
      throw error;
    }
  }
  function snapshot() {
    const now = Date.now();
    const rows = recent.filter((row) => row.at >= now - windowMs);
    const retrievals = rows.filter((row) =>
      ['search', 'read'].includes(row.operation),
    );
    const durations = retrievals
      .map((row) => row.durationMs)
      .sort((a, b) => a - b);
    return {
      schemaVersion: 1,
      scope: role,
      instanceId,
      observedFrom: Math.max(
        startedAt,
        now - windowMs,
        rows[0]?.at ?? startedAt,
      ),
      observedTo: now,
      capacity: limit,
      sampleCount: durations.length,
      errors: retrievals.filter((row) => row.outcome === 'error').length,
      medianMs: durations.length
        ? (durations[Math.floor((durations.length - 1) / 2)] +
            durations[Math.floor(durations.length / 2)]) /
          2
        : null,
      p95Ms:
        durations.length >= 20
          ? durations[Math.ceil(durations.length * 0.95) - 1]
          : null,
      // Additive: what the retrieval layer (search backend, cold/warm split)
      // did in this same bounded window. `backend`/`persisted`/`index` are
      // NOT set here — diagnostics.mjs has no reference to the search
      // backend, only to recorded events — a caller with that reference
      // (service.mjs, mcp-server.mjs) merges those fields in.
      retrieval: retrievalSummary(rows),
      operations: rows.slice().reverse(),
    };
  }
  return { record, measure, snapshot };
}

function median(sortedValues) {
  if (!sortedValues.length) return null;
  const mid = sortedValues.length - 1;
  return (
    (sortedValues[Math.floor(mid / 2)] + sortedValues[Math.ceil(mid / 2)]) / 2
  );
}

// Derives the `searches`/`lastSearch` parts of the retrieval snapshot from
// this instance's own bounded window of recorded events — the same `rows`
// snapshot() already filtered to windowMs. Exported so a caller assembling
// the full `/api/diagnostics` `retrieval` object (service.mjs, which also
// knows the search backend) can build it from one snapshot() call.
export function retrievalSummary(rows) {
  const searches = rows.filter((row) => row.operation === 'search');
  const cold = searches
    .filter((row) => row.phase === 'cold')
    .map((row) => row.durationMs)
    .sort((a, b) => a - b);
  const warm = searches
    .filter((row) => row.phase === 'warm')
    .map((row) => row.durationMs)
    .sort((a, b) => a - b);
  const last = searches.at(-1) ?? null;
  return {
    searches: {
      cold: cold.length,
      warm: warm.length,
      medianColdMs: median(cold),
      medianWarmMs: median(warm),
    },
    lastSearch: last
      ? {
          at: last.at,
          phase: last.phase ?? null,
          durationMs: last.durationMs,
          documentsRead: last.documentsRead ?? null,
          documentsReused: last.documentsReused ?? null,
          candidateCount: last.candidateCount ?? null,
          storeSyncMs: last.storeSyncMs ?? null,
        }
      : null,
  };
}
