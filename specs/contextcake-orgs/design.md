# ContextCake Organizations — Design

**Spec:** `specs/contextcake-orgs/spec.md`
**Date:** 2026-08-04
**Status:** Design approved; not yet implemented

How the organization directory works, in enough detail to build from. Every
control here traces to a rule in `docs/security/threat-model.md`.

---

## 1. Shape

There is no ContextCake server in v1.

```
GitHub                                    This machine
──────                                    ────────────
acme/.github
  .contextcake/directory.json  ──read──►  desktop main process
                                            │  validate on receipt
                                            ▼
                                          engine  ──►  pendingSources
                                            │             (inert)
                                            │  user confirms
                                            ▼
                                          manifest layer  ──►  index
```

The directory is a file in a repository the organization already owns. Reading
it is an ordinary authenticated GitHub read using the token the user already
connected. Publishing is a commit, so the organization's existing review process
governs what appears — and there is no write API of ours to attack.

## 2. The directory file

Location, by convention: `.contextcake/directory.json` in the organization's
`.github` repository — the repository GitHub already treats as the home for
org-wide defaults.

```json
{
  "version": 1,
  "sources": [
    {
      "name": "Platform docs",
      "kind": "github",
      "repo": "acme/platform-docs",
      "ref": "main",
      "subdir": "docs",
      "paths": ["docs/**", "CLAUDE.md"],
      "level": 0,
      "description": "How the platform is built and why."
    }
  ]
}
```

**The key set is closed.** These nine keys, and nothing else. A record carrying
any other key is discarded whole — not stripped and kept, because a stripped
record is one whose author expected different behavior from the one it will get.

| Key | Rule |
|---|---|
| `name` | `^[a-zA-Z0-9 _-]{1,40}$`, matching the source API's own grammar |
| `kind` | `github` (read-only adapter) or `okf-local` (clone). No others. |
| `repo` | `owner/name`, and its host must equal the host the directory was read from |
| `ref` | optional branch or tag |
| `subdir` | optional; no leading `/`, no `..`, must stay inside the clone |
| `paths` | optional selector list for the `github` adapter |
| `level` | integer, clamped to `ORG_MAX_LEVEL` (§4) |
| `description` | ≤ 500 characters, treated as untrusted display text |
| `version` | file-level; an unknown major version means discard the file |

**Keys that deliberately do not exist:** `apiBase`, `auth`, `command`, `args`,
`path`, `dir`, `cache`, `tokenEnv`. Each would let a publisher decide where a
credential is sent, what is executed, or what part of the disk is read.
`apiBase` is the sharpest: `buildSources` hands the adapter `layer.apiBase`
together with the resolved token, so a publisher-supplied API host is
credential exfiltration with extra steps.

Whole-file limits: 64 KB, 200 records. Over either, discard the file. A
directory is a list of pointers; anything larger is not one.

## 3. Reading it

In the desktop main process, in a new `org-directory.mjs` beside
`github-connections.mjs`. The engine never participates — it stays
dependency-free and never talks to an account service.

1. `GET /user/orgs` with the connected token → the user's organizations.
2. For each, `GET /repos/{org}/.github/contents/.contextcake/directory.json`.
   A 404 means the organization publishes nothing; that is the common case and
   is not an error.
3. Parse, validate (§5), cache the result with the time it was read.

Refresh on sign-in, on app start, hourly, and on an explicit button. Every
fetch is best-effort: a failure leaves the last cached copy in place and updates
only the "last checked" timestamp. A directory that cannot be read must never
block the app or empty a working list.

Both calls are ordinary credentialed GitHub requests and therefore inherit the
existing controls — host-bound token, `redirect: "manual"`, scrubbed errors.

## 4. Precedence: a clamp with a stated meaning

`ORG_MAX_LEVEL = 0` — the company baseline in the documented convention
(Personal 3 > Team 2 > Company 0).

The reasoning matters more than the number. Higher levels win
(`resolver.mjs:74`), and a locally added source defaults to level 1
(`service.mjs:793`). Clamping published records to 0 therefore means **anything
the user adds themselves outranks anything an organization publishes**, by
default and without the user configuring anything.

This is also why the plan's original phrasing was wrong and had to be fixed: it
proposed a range of 1–49, which — since higher wins — would have let a publisher
outrank the user's own decisions. A cap is only a safety property if it caps in
the direction precedence runs.

**Equal levels are decided by a date the publisher controls.** `sectionBeats`
(`resolver.mjs:157`) is a strict `>`, so an equal-level contest keeps whichever
contributor was ordered first — and `orderContributors` (`:72-77`) sorts equal
levels by the document's own `updated` frontmatter, newest first. That field is
written by whoever wrote the document. An org-published source dated
`2999-01-01` therefore wins any tie at the same level.

The default guarantee still holds: a locally-added source defaults to level 1
and beats org content at 0 outright, no tie involved. But the tie is reachable
in exactly the case the spec singles out — Dana deliberately placing her own
company handbook at level 0, where an org source also sits. Two required
consequences:

- The materializer must clamp a published record's effective `updated` to the
  time the directory was read, so a publisher cannot date its way to the front.
- A tie between an org-origin and a local-origin source at the same level must
  resolve to the local one regardless of dates. Provenance breaks the tie, not
  recency.

Two further consequences worth stating:

- An organization publishes **baseline**, not override. That is the correct
  semantics for a company handbook: it is what applies unless you have decided
  otherwise.
- A user who deliberately places a local source at or below 0 has chosen that
  ordering. We do not override a user's explicit choice to protect them from
  their own organization; the property we guarantee is that the *default* never
  favors the publisher.

The clamp is applied twice — once when the record is validated on receipt, and
again in the materializer that writes the layer — because a control enforced in
one place is one refactor from being enforced in none.

## 5. Validation, three times

Assume the file is hostile. It is fetched over the network from a repository
whose contents we do not control.

**On receipt** (`org-directory.mjs`): closed-key check, `kind` allowlist, `name`
grammar, repo host equality, `subdir` containment, level clamp, size limits.
Reject-not-strip. A rejected record is counted and surfaced, not silently
dropped — a directory that half-loads should say so.

**At the manifest boundary** (`manifest.mjs`): pending sources already pass
through `validatePendingSources`, which today rejects credential-shaped keys but
is **not** a closed-key allowlist. It must become one for `origin: "org"`
records, mirroring `assertOnlyKeys` in `settings-sync.mjs`. This is the fix for
the review finding that named this function as a chokepoint it was not.

**At materialization** (`service.mjs`): the layer is built field by field from
known keys. Never spread a remote object into a manifest layer. The `github`
kind hard-codes `api.github.com`; there is no code path where a published record
can influence the API host.

## 6. Pending, confirm, materialize

Validated records become `pendingSources` tagged `origin: "org"` with an
`org: { login, repo, sourceId, readAt }` block. They are inert: the cascade does
not read them, and the existing `pendingSourcesOwnerUserId` binding already
makes another account's pendings invisible.

The console shows a confirmation card per record: repository, publishing
organization, level to be applied, description. Confirm calls the existing
`addSourceApi`, which already removes the matching pending record on success.
Ignore records a `dismissedAt` locally so they are not re-offered.

Change is diffed by `sourceId` on each refresh:

| Upstream change | Behavior |
|---|---|
| New record | New pending card |
| Changed, still pending | Update in place |
| **Pointer changed** (repo/ref/subdir) on a confirmed source | **Return to pending for re-confirmation.** Never silently re-point a running layer — a publisher changing where a trusted layer reads from is exactly the trust-invalidating event that confirmation exists for. |
| Level/name/description changed | Surface as a suggestion; do not overwrite a user's local edit |
| Record removed, or access lost | Mark the layer `orgRemoved: true`; keep local content; offer detach-as-personal or remove |

Two organizations publishing the same repository is one source: dedupe by
normalized repo URL, name both publishers, apply the **lower** level.

## 7. Identity

`resolveAuthor` (`capture.mjs:130`) stays the single seam, with three callers.
When signed in, the app writes a local `identity.json` and captures gain a
separate `authorId` field. The author *string* keeps its current format —
`team-activity.mjs` compares author strings for cross-brain hits, and changing
the format would fracture that metric for a team where some members are signed
in and some are not. Attribution stays additive and never load-bearing.

## 8. Negative tests

Each maps to a SHALL NOT in the spec. These are the tests that fail if a control
is quietly removed.

| Test | Asserts |
|---|---|
| Hostile record with `apiBase` | Discarded at receipt; never reaches the manifest |
| Hostile record with `command` / `path` | Same |
| Record naming a repo on another host | Rejected |
| `subdir` of `../../etc` | Rejected |
| Record at `level: 49` | Clamped to 0 at receipt **and** at materialization |
| Org source vs. local source at default level, same concept | Local wins; org appears as dissent |
| Org record dated `2999-01-01`, tied at level 0 with a local source | Local wins; a publisher-supplied date never breaks a tie |
| Pointer change on a confirmed source | Returns to pending; layer keeps old target until re-confirmed |
| Directory of 65 KB, or 201 records | Whole file discarded |
| Directory with `version: 2` | Whole file discarded |
| Signed-out capture | Byte-identical to today's behavior |

## 9. Deferred: standalone organizations

Only when a non-GitHub team asks. Sketch, so the shape is known:

Tables `orgs`, `org_members` (roles `owner`/`admin`/`member`), `org_sources`
with the same closed column set as §2. Row-level security through
`SECURITY DEFINER` helper functions with `SET search_path = ''`, reading
`org_members` non-recursively — the standard Supabase pattern, and the one
`supabase/schemas/user_settings.sql` already follows.

Every write function re-derives the acting user from `auth.uid()`. Role and
target user are never parameters. Members are added by exact account identifier;
there is no guessable secret in the system. Join codes stay behind a flag and
only on evidence of real onboarding friction.

The blocking test before any of it ships: a member of organization A performs an
unfiltered read and receives zero rows from organization B, on every table.

## 10. Files

| Path | Change |
|---|---|
| `apps/desktop/src/main/org-directory.mjs` | New — fetch, validate, cache, diff |
| `apps/desktop/src/main/main.mjs` | Refresh triggers; IPC for list/confirm/dismiss |
| `apps/desktop/src/preload.cjs` | Narrow bridge, metadata only |
| `packages/core/src/manifest.mjs` | Closed-key allowlist for `origin: "org"` pendings |
| `packages/core/src/service.mjs` | Field-by-field materializer; `ORG_MAX_LEVEL` clamp |
| `packages/core/src/capture.mjs` | `authorId` alongside the author string |
| `apps/console/src/components/` | Confirmation cards; organization list |
