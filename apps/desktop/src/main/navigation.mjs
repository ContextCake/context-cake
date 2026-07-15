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

/** True only for IPC sent by the app's sole window while it is on the engine origin. */
export function isTrustedIpcSender(event, trustedWebContents, engineOrigin) {
  const frameUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || ''
  return Boolean(
    trustedWebContents
    && event?.sender === trustedWebContents
    && isEngineOrigin(frameUrl, engineOrigin),
  )
}
