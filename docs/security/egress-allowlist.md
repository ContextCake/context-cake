# Network egress

ContextCake claims your context stays on your machine. This page lists every
host the app can contact so you can check that claim yourself instead of
trusting it.

It covers every host ContextCake's own code contacts, as of the commit you are
reading. Two things sit outside that: an `mcp` source runs a program you
configured, which may do anything it likes, and a document can reference a
remote image (below). If you find the app talking to a host that neither this
page nor your own configuration explains, that is a bug worth
[reporting](../../SECURITY.md).

Checked and deliberately absent: no crash reporter, no analytics SDK, no CDN or
web-font fetch (fonts are self-hosted), and no Chromium background traffic —
this build ships without safe-browsing, the component updater, or variations,
and macOS spell-checking is the system's, so no dictionary is downloaded.

## There is no ContextCake server

We do not operate any host in the table below. The release you download has no
backend to call: sign-in is compiled out, and the packaged build carries an
`accounts: "disabled"` marker that outranks any environment variable.

So nothing you index is uploaded to us. It is not sent *nowhere*, though —
everything the app fetches is a public GitHub endpoint or a repository you
added, and if you configure team sync, ContextCake pushes to a repository you
chose. That case is described under [Team sync sends data out](#team-sync-sends-data-out).

## What the app contacts

| Host | When | What is sent | Carries a credential |
|---|---|---|---|
| `api.github.com` | You add a public GitHub repo as a source, or the app refreshes one | Repo owner/name, branch, file paths | No |
| `api.github.com` | You add a **private** GitHub repo and connected an account | The same, plus your token | Yes |
| `api.github.com` | The console checks for a new version | Nothing but the request itself | No |
| `github.com` | The Mac app checks for updates (at launch, then every six hours) | A stable per-install identifier — see below | No |
| `github.com` / `objects.githubusercontent.com` | An update is downloaded | Nothing but the request itself | No |
| `github.com` | You add a private repo — the clone itself | Your token, to authenticate the clone | Yes |
| `github.com` | **Once**, if you opt in to install metrics | The app version, as part of a file download | No |
| Any git host you configure | Cloning or pulling a source you added | Whatever git sends to that host | Your git credentials |
| The git remote of a `live` layer | **Outbound.** Confirming a capture, and session end with `--telemetry` | The capture you approved, plus one content-free line per tool call (concept id, layer name, capture kind) | Your git credentials |
| Any host named in an indexed document | Rendering a document containing a remote image | The request itself, to a host that document's author chose | No |
| Your GitHub Enterprise host | Only if you connect one | As above, scoped to that host | Yes |
| Your Supabase project | Only in a build made with `CC_ACCOUNTS=1` | Sign-in and a scrubbed settings blob | Yes |

Four of these need explaining.

**Install metrics are off unless you turn them on.** The app asks once, in a
native dialog, and the default is No. If you say yes it downloads one small
file from the release you are running, which tells us a copy started up. There
is no analytics library and no device identifier. The consent dialog notes that
GitHub sees your IP address, as it does for any download. The local marker that
stops it repeating is written only after the request *succeeds*, so a ping that
fails is retried on a later launch. See [app metrics](../app-metrics.md).

**The update check carries a per-install identifier.** electron-updater sends an
`x-user-staging-id` header — a UUID it generates once and stores in
`.updaterId`, so it is stable for the life of the installation and repeats every
six hours. It exists to make staged rollouts consistent. We do not collect it,
but GitHub receives it, and it is a stable identifier even though it is not tied
to you. Turning off update checks stops it.

**A document can make the app fetch a remote image.** Markdown rendered in the
console may reference an `https:` image, and no Content-Security-Policy
currently restricts that. Opening a document therefore signals to whatever host
its author chose. This is a real gap rather than a design choice, and it is
tracked as a fix — the renderer should be restricted to local and `data:`
images. Until then, treat opening a document from an untrusted repository the
way you would treat opening an untrusted email.

<h3 id="team-sync-sends-data-out">Team sync sends data out</h3>

Team sync is opt-in, off by default, and **not reachable from the Mac app** —
the app has no live-layer support. It runs from the MCP server or the
`contextcake` CLI, and only when you configure a `live` layer with a git remote
and pass the flags.

With it on, two things leave your machine, both to a repository you chose:

- **Captures**, when you confirm one. `log_capture` shows you the content first
  and `confirm_capture` is what publishes it, so nothing is shared without you
  seeing it.
- **Telemetry**, with `--telemetry`, at session end. One line per tool call:
  concept id, layer name, capture kind, harness name. No prompts, no document
  text, no search queries. There is no per-event confirmation for this.

A push that fails is queued and retried, not dropped. If that is not what you
want, do not configure a live layer — everything else works without one.

**Accounts are not in the shipped app.** Sign-in and settings sync exist in the
source and are switched off at build time. A release you download from us never
contacts Supabase. Building one that does takes `CC_ACCOUNTS=1` and credentials
we do not ship.

## What is not egress

Some things look like network access and are not.

- **The engine's own API.** The app talks to its engine over
  `http://127.0.0.1:<port>`, on a port that changes every launch and behind a
  token generated at startup. Loopback traffic never leaves the machine.
- **Menu links.** "Documentation" opens `contextcake.com/docs/` in *your
  browser*. The app does not fetch it.
- **MCP sources.** A layer with `"source": "mcp"` runs a program on your
  machine. Whether that program uses the network is up to the program, not to
  us — which is part of why running a manifest you did not write is treated as
  running a program you did not write. See [SECURITY.md](../../SECURITY.md).

## Checking for yourself

Poll the app's open connections during a few minutes of normal use:

```bash
while true; do sudo lsof -a -i -nP -c ContextCake -c git -c node; sleep 2; done
```

The `-a` is required. Without it `lsof` treats the selectors as *or*, and the
command returns every network socket on the machine unioned with every file the
named process has open — more output than no filter at all, scoped to nothing.
`git` and `node` are listed because clones run as separate child processes, as
does any MCP source you configured, and those are the connections most worth
seeing.

Because this is a sample every two seconds, a sub-second request can fall
between samples. The update check is the usual one to miss; run the menu's
**Check for Updates…** while watching if you want to catch it.

Adding a source and running a search are the interesting moments — that is when
a knowledge product would phone home if it were going to. You should see GitHub,
any git host you added, and nothing you cannot account for from the table above.

Packet capture will show you *that* connections happen and to which addresses,
but not their contents: everything here is TLS, so a `tcpdump` of port 443
yields ciphertext. Reading request bodies needs a proxy you trust with a
certificate the app accepts, which is a bigger exercise than this page can
honestly recommend as a quick check.

## Where credentials live

A GitHub token you connect is stored in `tokens.enc` under
`~/Library/Application Support/ContextCake/`. The file is encrypted with a key
from your login keychain and is readable only by your user account. A sign-in
session, in a build that has accounts, lives separately in `session.enc` — so
signing out cannot drop a GitHub connection, and vice versa. If the keychain is
unavailable, credentials are held in memory for that run and never written as
plaintext.

Two limits worth stating plainly. Another program running as you can ask the
keychain to decrypt it, so this protects against other accounts and stolen
backups, not against code you have already run. And disconnecting an account
forgets the token here — it stays valid on GitHub until you revoke it there.

## Related

- [SECURITY.md](../../SECURITY.md) — reporting a vulnerability, and what counts
- [app metrics](../app-metrics.md) — what the install ping does and does not send
