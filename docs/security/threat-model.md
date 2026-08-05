# Threat model

What ContextCake protects, what it does not, and who it assumes might be
hostile. Written down so the gaps are stated rather than discovered.

Scope: the engine (`packages/core/`), the Mac app (`apps/desktop/`), and the
console renderer. The product site is static and out of scope except where it
makes a claim about the app.

## What we are protecting

| Asset | Where it lives | If it leaks |
|---|---|---|
| Your context — concepts, captures, notes | Your disk, and any git repo you chose | The thing you bought the product to keep private |
| GitHub tokens you connect | `tokens.enc`, encrypted by your login keychain | Read access to every repo that token can reach |
| The engine's API token | Memory, per launch | Local API access for the life of that launch |
| Sign-in session (accounts builds only) | `session.enc` | Account takeover |

Ranked deliberately. A token leak is bad; a context leak is the product
failing at its one job.

## Who might be hostile

**A manifest you did not write.** The strongest assumption in the system. A
manifest names commands to run and hosts to talk to, so opening someone else's
manifest is opening someone else's program. Documented in
[SECURITY.md](../../SECURITY.md); reports that reduce to this are not bugs.

**A repository you added.** Its contents flow into an agent's context. Nothing
stops a document from containing text aimed at the agent reading it. Adding a
repo is trusting its authors.

**Another program running as you.** It can read anything you can, including a
decrypted keychain item. We do not claim to stop this.

**A network attacker.** Assumed to control DNS and to be able to answer
requests, but not to hold a valid certificate for GitHub.

**A future org administrator.** Not yet real — orgs are unbuilt. When they
exist, an admin can publish sources to everyone in the org, which is the same
power as handing out a manifest.

## What holds today

Each control exists because something specific goes wrong without it.

**A manifest names a credential; it never holds one.** `auth` accepts only
`keychain:<alias>` or `{"tokenEnv": "NAME"}`. Anything token-shaped is rejected
on read and on write, so a credential cannot be committed by accident.

**A token is bound to a host.** The manifest also decides where a credential
gets *sent*, through `apiBase`. Without binding, a manifest could name your real
alias, point at a host it controls, and collect your token. Binding withholds
the secret when the host does not match, and the source list says
`host-mismatch` rather than showing an empty repo.

**Credentialed requests do not follow redirects.** Following a 3xx would re-send
the token to whatever host the server named.

**Git's credential chain is cleared before we hand git a token.** Git's helper
list is cumulative and normally ends at the OS keychain, so supplying a token
without clearing it first makes *git* write a copy outside our store — one that
survives uninstall and ignores our Disconnect button.

**Secrets travel by message port, not argv or env.** Process arguments are
readable by any process running as you.

**The local API is guarded.** A per-launch bearer token, loopback-only binding,
and an origin check on mutating requests, so a web page you visit cannot drive
the engine.

**The renderer is sandboxed** and reaches the shell only through a narrow
preload bridge. No channel returns a stored secret to the renderer.

## What does not hold

Stated plainly, because a threat model that only lists wins is marketing.

- **Encryption at rest does not stop code running as you.** `safeStorage`
  protects against other accounts and stolen backups. Any program you run can
  ask the keychain to decrypt.
- **A token passed to git is visible in that process's environment** to another
  process running as you, for the life of the clone.
- **We cannot revoke a token.** Disconnecting forgets it locally. Revocation
  happens on GitHub.
- **Prompt injection from source content is unsolved.** Adding a repo means
  trusting what its documents say to an agent.
- **The update channel is the largest single risk.** The app installs signed
  code automatically. Whoever can cut a release, or holds the signing identity,
  can reach every install — a larger blast radius than any credential here.
  Reviewed in [the update channel](./update-channel.md): the release workflow
  itself is well gated, but nothing requires a release to come from it, and
  `app-v*` tags are unprotected.
- **Dependencies of the apps.** The engine has none by design. The Mac app and
  console do, and they ship in the artifact.

## Rules for work not yet done

Accounts, organizations, and brokered credentials are planned and gated behind
this document. These constraints are decided in advance so they are not
negotiated under deadline.

1. **Content never passes through a server we run.** An account may say who you
   are and point at a repository. The context itself moves between you and the
   host, directly.
2. **Nothing arriving over the network becomes runnable without local
   confirmation.** Org-published sources land as inert metadata until confirmed
   on the machine.
3. **An org directory may name only git-clonable sources.** No commands, no
   credentials, no absolute paths, no `apiBase`. Enforced at the database, on
   receipt, and again when a record is turned into a layer.
4. **Org content ranks below personal context, structurally.** Not by a
   configurable ceiling — higher levels win in the resolver, so a cap alone
   inverts into a promotion. This was caught in review of the plan, not in code.
5. **Entitlements are server-authoritative.** Plan state must never be read from
   a record the user can write.
6. **An integration credential is not a sign-in credential.** Revoking one must
   not silently revoke the other.
7. **Signed-out use is never degraded.** No account is required to use the
   product locally.

## Reporting

See [SECURITY.md](../../SECURITY.md). The hosts the app contacts are listed in
[the egress allowlist](./egress-allowlist.md); traffic to anything else is worth
a report.
