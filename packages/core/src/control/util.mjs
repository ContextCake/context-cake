// The machine-readable name for a deadline expiry. Retry logic keys on this
// (a timed-out index pass is worth retrying; a walk-cap throw is not), so the
// code is the contract — messages stay free to be written for humans, and
// several are pinned verbatim by tests.
export const TIMEOUT_CODE = "CONTEXTCAKE_TIMEOUT";

export function withDeadline(promise, ms, message, onTimeout = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* cancellation is best effort */ }
      const err = new Error(message);
      err.code = TIMEOUT_CODE;
      reject(err);
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
