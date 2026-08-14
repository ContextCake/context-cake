---
title: Network access and privacy
description: What anonymous usage metrics, update checks, and optional desktop account sync send, store, and leave on your Mac.
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
picks the newest release in its relevant tag namespace (`app-v*` for the shared
app/Web Demo renderer, `v*` for the playground/engine), compares it against the running version, and caches
the result for the session — at most one request per page load, no matter how many
components ask.

## It is disable-able

The ContextCake interface exposes **Check for updates** under **Settings → General**. The
Playground keeps the same preference in the small gear menu beside its update
notice. Both controls use the `cc-update-check` localStorage flag:

- **Web Demo** (embedded from `contextcake-console.pages.dev` on this site): off by
  default. The public embed is network-silent unless you turn the toggle on.
- **Live/local renderer**: on by default.
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

## Anonymous usage metrics

ContextCake asks before sharing anonymous usage metrics. We use these aggregate
counts to understand whether people can download and successfully open the app,
and to improve installation, onboarding, and release quality.

If you choose **Share Anonymous Metrics**, a successfully started packaged app
downloads one tiny file from its versioned GitHub Release:

```text
https://github.com/ContextCake/context-cake/releases/download/app-v<version>/install-ping.txt
```

The release URL identifies the app version. GitHub increments that release
asset's public download count. ContextCake sends no request body and adds no
identifier, account data, file name, local path, knowledge content, prompt,
device ID, or cookie. The count is anonymous to ContextCake and is never tied to
an account or settings-sync record. GitHub still receives the ordinary request
metadata it receives for downloads, including the network address used to make
the request; see [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

After a successful request, the app writes a local `install-metric-v1.json`
marker so the request is not repeated for that application-support directory.
Failed requests do not affect startup and may be retried later only while
anonymous metrics remain enabled.

Choose **Don't Share** in the first-run prompt to send nothing. You can change
this choice at any time under **Settings → General → Anonymous usage metrics**
or with **Share Anonymous Usage Metrics** in the application menu. Turning it
off stops an unreported first launch, failed-request retries, and future
anonymous metrics. It cannot remove a count already recorded because ContextCake
does not have an identifier that connects the aggregate count back to a person
or device. Update checks are a separate setting.

The preference is local to that Mac's ContextCake application-support directory
and is not included in account settings sync. A choice made on another Mac
therefore cannot enable metrics without the local first-run choice.

The resulting count is directional rather than a unique-person record: fresh
application-support directories can count again, and public release assets can
be downloaded outside the app. The first release with this counter also counts
existing users when they update and launch it; later releases do not recount the
same application-support directory.

## MCPB bundle activation

The Claude Desktop `.mcpb` bundle has a separate **Share anonymous activation
metrics** setting, off by default. When a person enables it and the bundled MCP
server starts successfully, it downloads one tiny versioned release asset:

```text
https://github.com/ContextCake/context-cake/releases/download/app-v<version>/mcpb-install-ping.txt
```

The request has no body and contains no ContextCake manifest, file path, tool
input, prompt, knowledge content, account information, device ID, or cookie. A
local marker prevents repeat reports. Choosing not to share means no request;
an error cannot delay the MCP server. This remains a directional aggregate,
never an identity or a unique-person metric.

The npm CLI adds no installation or runtime telemetry. Homebrew's anonymous
analytics, if a user leaves it enabled, are collected and controlled by
Homebrew rather than ContextCake.

## Why this exists

ContextCake is privacy-by-default: local engine work does not phone home, update checks
are switchable, and account traffic is opt-in. For the browser UIs, the update flag
persists in localStorage; the packaged app stores its native update preference in the
local application settings file.

## GitHub source connections

GitHub source connections are local and independent of optional ContextCake
accounts. When you paste a personal access token under **Settings → Connections**,
the app makes one credentialed request to that GitHub host to verify the token and
identify the account. It then stores the token in `tokens.enc`, encrypted with
OS-keychain-backed `safeStorage` when available. If encryption is unavailable, the
token remains memory-only for that run and is not written as plaintext.

The renderer can list only connection metadata: alias, login, GitHub host,
token type, and creation time. It cannot read a stored token back. The token reaches
the isolated engine through Electron's process message port, not command-line
arguments or the engine environment. For Git-over-HTTPS clone and pull operations,
the engine passes a matching host-bound token to that individual Git child through
its environment, with tracing disabled and persistent credential helpers reset.

Disconnecting deletes the local stored copy but cannot revoke the token at GitHub.
Revoke it separately in the GitHub account's token settings. Connection metadata and
tokens are never included in settings sync.

## Optional desktop accounts

> **Availability: not shipped.** Released builds of ContextCake for Mac contain
> no sign-in, send nothing to any account service, and store nothing about you
> on a server. There is no ContextCake account to create. The section below
> describes a capability the app can be built with but currently is not; it is
> kept so the behavior is documented if that ever changes.

ContextCake for Mac works fully while signed out. Signing in adds settings sync; it
does not gate the local engine, sources, profiles, resolve tools, or MCP server.

When you sign in with GitHub, authentication runs in your system browser
through Supabase OAuth with PKCE. The desktop app persists the resulting session only
when OS-keychain-backed encryption is available; otherwise the session stays in memory
for that run. Raw tokens are never exposed to the renderer or written to logs.

The server-side account data includes:

- Supabase-managed Auth user and provider-identity records, including the provider's
  email/profile metadata and authentication timestamps;
- Supabase-managed session and refresh-token records;
- Supabase Auth audit logs, which can include the user ID, IP address, user agent,
  provider metadata, and event timestamps;
- one owner-only `user_settings` row. Its JSON blob is limited to 1,000,000 bytes
  and can contain only `theme`, `updateCheck`, `profiles`, and `sources`.
  Profile metadata is limited to names/labels, source membership,
  theme preference, and manifest layers. Source metadata is limited to its
  name, kind, precedence, repository/ref/origin, cache policy, and scrubbed
  placeholders for machine-local execution or credentials.

Before upload, ContextCake replaces local source paths, cache directories, executable
MCP commands and arguments, Keychain references, and `tokenEnv` values with scrub
markers. It then rejects the entire upload if a recognized credential, URL credential,
email address, or context-content pattern remains. Synced integrations therefore
require local setup on each Mac and can never activate a remote command.

Settings sync never includes knowledge or document content, resolved output,
integration tokens, environment-variable values, absolute local paths, metric
events, or the local anonymous-metrics preference. Deleting the account removes
the Supabase Auth user and the cascading settings row; local ContextCake files
and settings are left untouched.
Project-folder mappings, matched roots, and the app's active profile are also
local-only. A remote settings row cannot activate a profile or redirect a trusted
local executable source.
Profile-aware promotion keeps a small machine-local binding record containing
opaque ids, configuration fingerprints, and a capture hash until approval
finishes. It contains no context body and is never part of settings sync or the
team live repository.
Supabase-managed operational and audit logs follow the project's configured retention
and are not necessarily removed when the account is deleted.

Installed Pack files, local overlays, checksums, and the manifest's local Pack-version
registry are also excluded from settings sync. A Pack-managed layer can contribute its
Pack identity and active version as ordinary configuration metadata, while its absolute
path is scrubbed exactly like every other local source path.

## Related

- [The trust boundary](/docs/concepts/trust-boundary) — the one place ContextCake
  does execute code you didn't write directly (an `mcp` layer's `command`)
- [Playground tour](/docs/guides/playground-tour) — where the settings menu lives
