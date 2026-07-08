---
title: Update checks and privacy
description: What the Console and Playground send when they check for a newer release, and how to turn it off.
---

The engine itself — `resolver.mjs`, `mcp-server.mjs`, and every other CLI tool — makes
no network calls of its own beyond what a layer's `source` requires (an `mcp` layer
spawns the command you configured). This page is about a separate, optional
convenience in the two UI surfaces: the [Console](/demo) and the
[Playground](/docs/guides/playground-tour).

## What it sends

Both UIs can check whether a newer ContextCake release exists. The check is a single
unauthenticated HTTPS `GET` to a pinned host:

```
https://api.github.com/repos/siracusa5/context-cake/releases/latest
```

Nothing is attached beyond the implicit HTTP request — no personal data, no tokens,
no identifiers, no telemetry. The request carries the same information any browser
request to that URL would (the standard HTTP headers your client sends; GitHub sees
whatever it would see from any anonymous visitor). The response — the latest release
tag and its URL — is compared against the running version and cached for the session,
so at most one request happens per page load, no matter how many components ask.

## It is disable-able

Both surfaces expose a **Check for updates** toggle in the header, next to any
"update available" notice (a small gear icon opens the setting). It is backed by a
single localStorage flag, `cc-update-check`, shared by the Console and the
Playground:

- **Console, demo build** (the public `/demo-app/` embed on this site): off by
  default. The public embed is network-silent unless you turn the toggle on.
- **Console, live/local use**: on by default.
- **Playground**: on by default — it is a local dev tool, not a public embed.

When the toggle is off, no network request is made at all — the check function
returns immediately without calling `fetch`.

## Why this exists

ContextCake is privacy-by-default: the engine doesn't phone home, and the one place a
UI convenience touches the network, it's unauthenticated, minimal, cached, and
switchable. If you'd rather never make the call — air-gapped environments, strict
network policies, or just preference — turn the toggle off once and it stays off
(the flag persists in localStorage).

## Related

- [The trust boundary](/docs/concepts/trust-boundary) — the one place ContextCake
  does execute code you didn't write directly (an `mcp` layer's `command`)
- [Playground tour](/docs/guides/playground-tour) — where the settings menu lives
