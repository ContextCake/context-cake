# Network egress

ContextCake claims your context stays on your machine. This page lists every
host the app can contact so you can check that claim yourself instead of
trusting it.

The list is exhaustive as of the commit you are reading. If you find the app
talking to a host that is not here, that is a bug worth
[reporting](../../SECURITY.md).

## There is no ContextCake server

We do not run a backend. No host in the table below is operated by us. Your
concepts, captures, prompts, file paths, and search queries are never sent
anywhere — there is nowhere to send them.

Everything the app fetches is either a public GitHub endpoint or a repository
you chose to add.

## What the app contacts

| Host | When | What is sent | Carries a credential |
|---|---|---|---|
| `api.github.com` | You add a public GitHub repo as a source, or the app refreshes one | Repo owner/name, branch, file paths | No |
| `api.github.com` | You add a **private** GitHub repo and connected an account | The same, plus your token | Yes |
| `api.github.com` | The console checks for a new version | Nothing but the request itself | No |
| `github.com` | The Mac app checks for updates (at launch, then every six hours) | Nothing but the request itself | No |
| `github.com` / `objects.githubusercontent.com` | An update is downloaded | Nothing but the request itself | No |
| `github.com` | You add a private repo — the clone itself | Your token, to authenticate the clone | Yes |
| `github.com` | **Once**, if you opt in to install metrics | The app version, as part of a file download | No |
| Any git host you configure | Cloning or pulling a source you added | Whatever git sends to that host | Your git credentials |
| Your GitHub Enterprise host | Only if you connect one | As above, scoped to that host | Yes |
| Your Supabase project | Only in a build made with `CC_ACCOUNTS=1` | Sign-in and a scrubbed settings blob | Yes |

Two of these need explaining.

**Install metrics are off unless you turn them on.** The app asks once, in a
native dialog, and the default is No. If you say yes it downloads one small
file from the release you are running, which tells us a copy started up. There
is no analytics library, no device identifier, and no second request — a local
marker prevents it. See [app metrics](../app-metrics.md).

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

Watch the app's traffic for a few minutes of normal use:

```bash
sudo lsof -i -nP -c ContextCake
```

Or capture it, if you want to read the requests:

```bash
sudo tcpdump -i any -n 'tcp port 443' -c 200
```

You should see connections to GitHub and to any git host you added, and nothing
else. Adding a source and running a search are the interesting moments — that
is when a knowledge product would phone home if it were going to.

## Where credentials live

A GitHub token you connect is stored in `tokens.enc` under
`~/Library/Application Support/ContextCake/`. The file is encrypted with a key
from your login keychain and is readable only by your user account.

Two limits worth stating plainly. Another program running as you can ask the
keychain to decrypt it, so this protects against other accounts and stolen
backups, not against code you have already run. And disconnecting an account
forgets the token here — it stays valid on GitHub until you revoke it there.

## Related

- [SECURITY.md](../../SECURITY.md) — reporting a vulnerability, and what counts
- [app metrics](../app-metrics.md) — what the install ping does and does not send
