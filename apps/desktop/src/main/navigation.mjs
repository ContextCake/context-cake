/**
 * True only for navigations that stay on the per-launch local engine origin.
 *
 * Do not use a string prefix check here: an URL such as
 * `http://127.0.0.1:4317@attacker.example/` starts with the local origin but
 * is actually hosted by attacker.example.
 */
export function isEngineOrigin(url, engineOrigin) {
  try {
    return new URL(url).origin === new URL(engineOrigin).origin
  } catch {
    return false
  }
}
