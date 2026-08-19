# Release gates

A gate is a check that must pass before a release is published, recorded here so
the answer to "was this validated?" is a file rather than a memory.

**This file is enforced.** `app-release.yml` refuses to publish while any
`## Open:` section remains below. Closing a gate means moving it under
`## Closed:` with its evidence — not deleting it. To ship with a gate knowingly
unmet, say so in the file; the point is that the decision is written down.

## Closed: hosted OAuth and settings sync (#44)

**Resolved 2026-07-30 by not shipping the feature.** Accounts are off by default
(`CC_ACCOUNTS`, see below), so there is no hosted account system in a published
build to validate. The three manual checks below stay written down because they
become due again the moment anyone packages with `CC_ACCOUNTS=1`.

The hosted project had **zero rows in `user_settings`** when this was decided —
nobody had signed in, so disabling stranded no one.

### Why the feature was disabled rather than validated

Everything the sync path can safely carry is scrubbed before upload:
`scrubSettings` replaces `command`, `args`, `path`, `dir`, anything containing an
absolute path, and anything secret-shaped with markers. What crosses machines is
a preference blob and profile shapes with holes in them, which you then re-point
by hand on the second Mac.

That is a thin return for a hosted Postgres holding user rows in a product whose
claim is that context stays on your machine — and it was the only thing making
that claim need an asterisk. The stated justification was a hook for
entitlements, and Packs shipped as a free preview with payments dormant behind
`paymentsLive` (now in `apps/site/src/config/flags.json`, next to the
`commerceVisible` flag that hides prices from the site entirely), so nothing is
being entitled yet.

The code, migrations and tests are all still here and still run in CI. Turning
accounts back on is one environment variable, and the better version — settings
sync over the user's own git repo, on the `git-core.mjs` / `git-sync.mjs` rails
team sync already uses — needs no hosted service at all.

### What was actually shipped unvalidated

Kept as the record of the process failure. PR #38 merged 2026-07-15 deferring
three hosted acceptance checks to #44 with the note that they "remain required
before publishing the desktop account-sync release." Three releases shipped
since:

| Release | Date | Account sync reachable? |
|---|---|---|
| 0.1.0 | 2026-07-17 | yes |
| 0.2.0 | 2026-07-20 | yes |
| 0.3.0 | 2026-07-29 | yes |

Reachable, not merely present: packaging threw unless `SUPABASE_URL` and
`SUPABASE_ANON_KEY` were set, `app-release.yml` supplied both from repository
secrets, and `AccountPanel` rendered unconditionally in Settings with Sign in,
Sign out and Delete account. Every published build could sign a user into the
hosted project. Nobody did.

This was a process failure, not a defect report. Nothing here says the feature is
broken — it says nobody had confirmed it works on the artifact users download.

### What CI already discharges

These sub-checks are covered by automated tests on every PR (`apps/desktop/test/`,
run by the `desktop` job in `ci.yml`) and do not need to be repeated by hand:

| Sub-check | Covered by |
|---|---|
| Callback `state` validation; only an encrypted session is written | `auth.test.mjs` — OAuth IPC smoke |
| Cancel and retry cannot orphan or hijack an in-flight attempt | `auth.test.mjs` — duplicate sign-in, late/stale refresh, sign-out races |
| Sign-out clears the encrypted local session, including offline | `auth.test.mjs` — sign-out with Supabase offline |
| Paths, MCP commands/args, cache dirs and credential references never sync as runnable config | `settings-sync.test.mjs` — scrub, allowlist, quarantine, path-shaped keys |
| A second client converges: tombstones, account switch, last-write-wins | `settings-sync.test.mjs` — dirty tombstone, shadow discard, remote-row precedence |

### What would still need a human, if accounts are ever re-enabled

Three things cannot be simulated: a **packaged** app, a **second physical
machine**, and the **hosted** database. Each needs a person — the OAuth flow
requires entering real credentials.

The packaged acceptance must use the separate Settings window. Confirm
`Command-,`, the application menu, sidebar Settings control, and command palette
all focus the same window; closing it during pending OAuth cancels the attempt;
and a successful callback focuses Account only when Settings is already open.
Repeat a System appearance change with both trusted windows open.

**These are due again on any build packaged with `CC_ACCOUNTS=1`.** Do not ship
one without them.

**1. Packaged OAuth and Keychain persistence**

```bash
cd apps/desktop && CC_ACCOUNTS=1 SUPABASE_URL=<hosted> SUPABASE_ANON_KEY=<publishable> npm run dist
```

Then, on the installed app: complete the GitHub browser flow, confirm
`contextcake://auth/callback` returns to the app, quit and relaunch, and confirm
the session survived. Then cancel a sign-in mid-flow and confirm nothing persists.

**2. Second-machine settings roundtrip**

Sign in to the same account on a second Mac or macOS user. Change a preference on
each side and confirm both directions converge. Confirm the second machine's
sources arrive as non-runnable pending metadata, not as executable configuration.

**3. Hosted account deletion**

With a disposable account, invoke Delete account. Confirm in the hosted project
that the Auth user and the `user_settings` row are both gone, that local session
state is cleared, and that the app still works signed out.

### Evidence to record

Packaged version and commit SHA · macOS versions and devices used · redacted
screenshots or logs per check · confirmation the hosted records were removed.

### Why it slipped

Nothing connected the open issue to the release workflow. A gate declared only in
an issue is a gate only a person can enforce, and the person was busy shipping.

Fixed by the "Verify no release gate is open" step in `app-release.yml`: a tag
push fails while any `## Open:` section remains in this file. That is the
intended behavior, not an obstacle to route around.
