---
title: Network access and privacy
description: What update checks and optional desktop account sync send, store, and leave on your Mac.
---

The engine itself — `resolver.mjs`, `mcp-server.mjs`, and every other CLI tool — makes
no network calls beyond what a layer's `source` requires (an `mcp` layer spawns the
command you configured). The UI surfaces can check for releases, the Mac app has a
native updater, and signed-in Mac users can opt into account and settings-sync traffic.
Each path is described below.

## What it sends

Both UIs can check whether a newer ContextCake release exists. The check is a single
unauthenticated HTTPS `GET` to a pinned host:

```text
https://api.github.com/repos/ContextCake/context-cake/releases?per_page=20
```

Nothing is attached beyond the implicit HTTP request — no application-added personal
data, tokens, identifiers, or telemetry. The request carries the same information any
browser request to that URL would (the standard HTTP headers your client sends; GitHub
sees whatever it would see from any anonymous visitor). From the response, each surface
picks the newest release in its own tag namespace (`console-v*` for the console,
`v*` for the playground/engine), compares it against the running version, and caches
the result for the session — at most one request per page load, no matter how many
components ask.

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

## Desktop app updates

The packaged Mac app has a separate native updater. When **Check for Updates
Automatically** is enabled, it contacts the ContextCake GitHub Releases feed at
startup and every six hours, sending the version and platform information needed to
select an artifact. electron-updater also sends a stable random rollout identifier in
the `x-user-staging-id` header and stores it as `.updaterId` in ContextCake's local
application-support directory. The identifier coordinates staged rollouts; it is not
an account ID. If a newer app release exists, the updater downloads the signed update in
the background and installs it when the app quits. Turn off the native menu checkbox
to prevent automatic checks; the manual **Check for Updates…** command contacts GitHub
only when you choose it.

## Why this exists

ContextCake is privacy-by-default: local engine work does not phone home, update checks
are switchable, and account traffic is opt-in. For the browser UIs, the update flag
persists in localStorage; the packaged app stores its native update preference in the
local application settings file.

## Optional desktop accounts

> **Availability:** Accounts are part of the next signed ContextCake for Mac release.
> They are not considered live until the packaged GitHub flow and deletion/sync
> acceptance checks pass.

ContextCake for Mac works fully while signed out. Signing in adds settings sync; it
does not gate the local engine, sources, profiles, resolve tools, or MCP server.

When you sign in with GitHub, authentication runs in your system browser
through Supabase OAuth with PKCE. The desktop app persists the resulting session only
when OS-keychain-backed encryption is available; otherwise the session stays in memory
for that run. Raw tokens are never exposed to the Console renderer or written to logs.

The server-side account data includes:

- Supabase-managed Auth user and provider-identity records, including the provider's
  email/profile metadata and authentication timestamps;
- Supabase-managed session and refresh-token records;
- Supabase Auth audit logs, which can include the user ID, IP address, user agent,
  provider metadata, and event timestamps;
- one owner-only `user_settings` row containing UI preferences, profile definitions,
  and source configuration metadata.

Before upload, ContextCake replaces local source paths, cache directories, executable
MCP commands and arguments, Keychain references, and `tokenEnv` values with scrub
markers. It then rejects the entire upload if any credential, personal identifier, or
context-content pattern remains. Synced integrations therefore require local setup on
each Mac and can never activate a remote command.

ContextCake never syncs knowledge or document content, resolved output, integration
tokens, environment-variable values, absolute local paths, analytics, or telemetry.
Those stay on the Mac. Deleting the account removes the Supabase Auth user and the
cascading settings row; local ContextCake files and settings are left untouched.
Supabase-managed operational and audit logs follow the project's configured retention
and are not necessarily removed when the account is deleted.

## Related

- [The trust boundary](/docs/concepts/trust-boundary) — the one place ContextCake
  does execute code you didn't write directly (an `mcp` layer's `command`)
- [Playground tour](/docs/guides/playground-tour) — where the settings menu lives
