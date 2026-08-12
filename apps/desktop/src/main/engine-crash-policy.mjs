// Policy for engine exits the app did not ask for: how many restarts, how
// spaced, and when a source becomes the suspect. Pure data-in data-out —
// main.mjs owns the timers, dialogs and forks — so `npm test` can pin every
// branch of the decision table without booting Electron.
//
// The shape of the problem: the single most likely reason a HEALTHY engine
// exits is an OOM during a large index — knowable and recoverable — but an
// engine that dies deterministically on the same source must not become a
// heater. Bounded restarts answer the first; the quarantine answers the
// second; the window and the healthy-reset keep one bad afternoon from
// counting against next week.

export const CRASH_WINDOW_MS = 10 * 60_000; // restarts are counted within this sliding window
export const CRASH_MAX_RESTARTS = 2; // per window, before the app stops re-forking
export const CRASH_BACKOFFS_MS = [1_000, 10_000]; // first retry fast, second cautious
export const HEALTHY_RESET_MS = 5 * 60_000; // this long healthy forgives the count
export const CRASH_BREADCRUMB_LIMIT = 5; // entries kept in engine-crashes.json

/** Drop restart timestamps that have aged out of the counting window. */
export function pruneRestarts(restarts, now) {
  return (restarts ?? []).filter((at) => now - at < CRASH_WINDOW_MS);
}

/**
 * Should the app re-fork after this crash, and after how long?
 * `restarts` is the pruned list of restart timestamps in the current window.
 */
export function nextRestartDecision(restarts) {
  const used = restarts?.length ?? 0;
  if (used >= CRASH_MAX_RESTARTS) return { restart: false, backoffMs: null };
  return { restart: true, backoffMs: CRASH_BACKOFFS_MS[used] };
}

/**
 * The crash-loop breaker: name the suspect source, or null.
 *
 * Only when the two MOST RECENT crashes were both observed mid-index and
 * their indexing source lists intersect in exactly one name. An ambiguous
 * intersection (several sources in flight both times — the concurrency cap
 * allows up to 4) restarts without blaming anyone: quarantining an innocent
 * source trades one support thread for another. The restart cap still ends
 * the loop either way.
 */
export function quarantineCandidate(breadcrumbs) {
  const [prev, last] = (breadcrumbs ?? []).slice(-2);
  if (!prev || !last) return null;
  const a = new Set(prev.indexingSources ?? []);
  const b = last.indexingSources ?? [];
  const shared = b.filter((name) => a.has(name));
  return shared.length === 1 ? shared[0] : null;
}

/** Append a breadcrumb, keeping the file bounded. */
export function appendBreadcrumb(breadcrumbs, entry, limit = CRASH_BREADCRUMB_LIMIT) {
  return [...(breadcrumbs ?? []), entry].slice(-limit);
}
