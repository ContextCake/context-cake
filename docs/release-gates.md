# Release gates

A gate is a check that must pass before a release is published, recorded here so
the answer to "was this validated?" is a file rather than a memory.

**This file is enforced.** `app-release.yml` refuses to publish while any
`## Open:` section remains below. Closing a gate means moving it under
`## Closed:` with its evidence — not deleting it. To ship with a gate knowingly
unmet, say so in the file; the point is that the decision is written down.

## Open: hosted OAuth and settings sync (#44)

**Status: breached.** PR #38 merged 2026-07-15 deferring three hosted acceptance
checks to #44 with the note that they "remain required before publishing the
desktop account-sync release." Three releases have shipped since:

| Release | Date | Account sync reachable? |
|---|---|---|
| 0.1.0 | 2026-07-17 | yes |
| 0.2.0 | 2026-07-20 | yes |
| 0.3.0 | 2026-07-29 | yes |

Reachable, not merely present: `apps/desktop/scripts/generate-supabase-config.mjs`
throws unless `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set, `app-release.yml`
supplies both from repository secrets, and `AccountPanel` renders unconditionally
in Settings with Sign in, Sign out, and Delete account. Every published build can
sign a user into the hosted project.

This is a process failure, not a defect report. Nothing here says the feature is
broken — it says nobody has confirmed it works on the artifact users download.

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

### What still needs a human

Three things cannot be simulated: a **packaged** app, a **second physical
machine**, and the **hosted** database. Each needs John — the OAuth flow requires
entering real credentials, which is not something an agent should do on his
behalf.

**1. Packaged OAuth and Keychain persistence**

```bash
cd apps/desktop && SUPABASE_URL=<hosted> SUPABASE_ANON_KEY=<publishable> npm run dist
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

### Evidence to record when closing

Packaged version and commit SHA · macOS versions and devices used · redacted
screenshots or logs per check · confirmation the hosted records were removed.

### Why it slipped

Nothing connected the open issue to the release workflow. A gate declared only in
an issue is a gate only a person can enforce, and the person was busy shipping.

Fixed by the "Verify no release gate is open" step in `app-release.yml`, added
alongside this file: tagging `app-v0.3.1` now fails while the section above still
says `## Open:`. That is the intended behavior, not an obstacle to route around —
the next release is blocked until these three checks are done or the decision to
ship without them is written here.

## Closed:

*(none yet — the first gate to close will be #44, above)*
