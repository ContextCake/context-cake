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
];

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
  async function measure(operation, action) {
    const start = performance.now();
    try {
      const result = await action();
      record({
        operation,
        outcome: result?.indexing ? 'partial' : 'ok',
        durationMs: performance.now() - start,
        resultCount: Array.isArray(result)
          ? result.length
          : (result?.hits?.length ?? (result ? 1 : 0)),
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
      operations: rows.slice().reverse(),
    };
  }
  return { record, measure, snapshot };
}
