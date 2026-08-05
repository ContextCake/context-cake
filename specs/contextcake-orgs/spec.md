# ContextCake Organizations — Spec

**Date:** 2026-08-04
**Status:** Approved (decisions locked with John, 2026-08-04)
**Workflow:** Requirements-First (desired behavior known; membership backend chosen below)
**Membership decision:** **GitHub-derived, from a file in a repository the organization
owns.** v1 ships a reader and no server. Standalone organizations — with a database, row
security, and add-by-identifier — arrive only when a non-GitHub team needs them.
**Depends on:** `specs/contextcake-auth/spec.md` (sign-in), `docs/security/threat-model.md`
(binding rules), the GitHub credential broker (PR #89, merged)

---

## 1. Problem statement

Joining a team's shared context is entirely manual and invisible to the product.
A new teammate clones two repositories by hand, writes a `layers.json` of
absolute paths that are not tilde-expanded, sets a git identity, arranges git
credentials, and runs an MCP server from a terminal. The Mac app cannot do any
of it — the word "live" never appears in its wizard.

The missing piece is not sync. The repositories already sync themselves through
git. The missing piece is **discovery**: knowing which repositories your
organization treats as shared context, without someone pasting URLs into Slack.

An account is worth re-enabling only if it answers that. Accounts were switched
off on 2026-07-30 because settings sync alone did not justify a hosted database
beside a local-first promise (`docs/release-gates.md`). Discovery is a different
proposition — and as specified here it needs no hosted database either.

## 2. Goals

- **Sign in, and your organization's shared repositories appear** as
  confirm-to-activate sources. No URLs to collect, no manifest to hand-write.
- **Reuse identity that already exists.** A team that is already a GitHub
  organization *is* the membership list. Read it; do not reimplement it.
- **Keep the directory in git.** The list of published repositories is a file in
  a repository the organization owns, so publishing is a commit, changes are
  reviewable, and permission to read the list is permission to read the repo.
- **The directory is a phone book, not a warehouse** — pointers only. Context,
  captures, and telemetry keep riding git and never reach a server we run.
- **Classification belongs to the knowledge, not to whoever added it.** A solo
  founder can mark their own company handbook as company baseline; an
  organization cannot publish something that outranks a member's own context.
- **Local-first is preserved.** Signed out, everything except discovery works.

## 3. Non-goals (v1)

Repository *access* (§6) · standalone non-GitHub organizations (§8) · any write
path — the live team layer, captures, promotions, and telemetry stay configured
as they are today · entitlements, seats, billing · email invitations and
domain-based joining · organization-published `mcp` sources · SAML/SSO · a
web-console organization UI.

## 4. User stories

- **Priya** joins a company already on GitHub. She signs in with GitHub, sees
  "Acme publishes 4 knowledge graphs", confirms three, and they index. She never
  sees a repository URL.
- **An Acme admin** publishes a new repository by opening a pull request against
  a JSON file. Their existing review process applies; nobody gains an admin
  console.
- **Dana**, a solo founder, wants her company handbook to behave as baseline —
  below her own decisions, not above them — even though she is the one adding
  it. She adds it locally and sets its level to company. Nothing about it being
  "hers" forces personal precedence.
- **Theo** never signs in. Cascade, sources, captures, and MCP server work
  exactly as before.
- **A hostile admin** publishes a repository full of text aimed at an agent. It
  arrives inert, requires confirmation, ranks below every personal layer, and
  can execute nothing.
- **A removed member** loses the directory at the next refresh. Repositories she
  already cloned keep working locally until she removes them; her git access is
  revoked at GitHub, not by us.

## 5. Acceptance criteria (EARS)

### Discovery

- [ ] WHEN a user signs in with GitHub THE SYSTEM SHALL read their GitHub
  organization memberships and, for each, attempt to read that organization's
  directory file.
- [ ] WHEN an organization publishes no directory file THE SYSTEM SHALL treat it
  as absent and SHALL show nothing for that organization.
- [ ] WHEN a user belongs to no organization with a directory THE SYSTEM SHALL
  change no behavior anywhere in the app.
- [ ] WHEN the directory cannot be read (offline, expired token, revoked access)
  THE SYSTEM SHALL continue from the last cached copy and SHALL report when it
  was last checked, rather than presenting an error.
- [ ] WHEN a user loses access to the organization's repository THE SYSTEM SHALL
  stop offering that directory at the next refresh and SHALL NOT remove or
  disable any source the user already confirmed.
- [ ] WHEN the directory file is larger than a published byte limit, or is not
  valid JSON, THE SYSTEM SHALL discard it entirely rather than parse part of it.

### The directory record

- [ ] WHEN a directory is read THE SYSTEM SHALL accept only records naming a
  git-clonable kind — a clone (`okf-local`) or the read-only `github` adapter.
- [ ] WHEN a record carries any key outside the published closed set THE SYSTEM
  SHALL discard that record, rather than stripping the key and keeping it.
- [ ] WHERE a record could name where a credential is sent or what is executed —
  specifically `apiBase`, `auth`, `command`, `args`, `path`, and `dir` — THE
  SYSTEM SHALL have no representation for those keys and SHALL reject them.
- [ ] WHEN a record names a repository THE SYSTEM SHALL require it to resolve to
  the same host the directory itself was read from, and SHALL reject a record
  pointing at any other host.
- [ ] WHEN a record names a sub-directory THE SYSTEM SHALL reject any value that
  escapes the repository root.

### Precedence and classification

- [ ] WHEN an organization-published source is materialized THE SYSTEM SHALL
  clamp its level to at most the company baseline, so that a source added
  locally at the default level always resolves above it.
- [ ] WHERE the clamp applies THE SYSTEM SHALL enforce it both when the record is
  received and again when the layer is written, never in one place only.
- [ ] WHEN a user adds a source themselves THE SYSTEM SHALL allow any level,
  including company baseline, regardless of who authored the content.
- [ ] WHEN a user deliberately sets a local source at or below the organization
  band THE SYSTEM SHALL honor that choice, because the user is the one making it.
- [ ] WHEN an organization source and a locally-added source sit at the same
  level THE SYSTEM SHALL resolve the local one as effective, regardless of
  either document's `updated` date.
- [ ] WHERE a published record supplies a date THE SYSTEM SHALL NOT let it
  affect ordering beyond the moment the directory was read, so a publisher
  cannot win a tie by dating a document into the future.
- [ ] WHEN an organization source and a personal source define the same concept
  section THE SYSTEM SHALL resolve the personal one as effective and SHALL
  surface the organization's value as dissent.

### Confirmation and change

- [ ] WHEN a directory record arrives THE SYSTEM SHALL store it as an inert
  pending source contributing nothing to the cascade until confirmed on that
  machine.
- [ ] WHEN a user confirms a pending source THE SYSTEM SHALL show the repository,
  the publishing organization, and the level to be applied, before it is added.
- [ ] WHEN an already-confirmed source's pointer changes upstream — repository,
  ref, or sub-directory — THE SYSTEM SHALL return it to the pending state for
  re-confirmation and SHALL NOT silently re-point a running layer.
- [ ] WHEN an organization retires a published source THE SYSTEM SHALL mark the
  local layer as no longer published and SHALL leave its local content intact.
- [ ] WHEN a user dismisses a pending source THE SYSTEM SHALL record that locally
  and SHALL NOT re-offer it on the next refresh.
- [ ] WHEN two organizations publish the same repository THE SYSTEM SHALL treat it
  as one source, name both publishers, and apply the lower of the suggested
  levels — never the higher.

### Identity and attribution

- [ ] WHEN a signed-in user authors a capture THE SYSTEM SHALL record a verified
  account identifier alongside the existing author string, and SHALL NOT change
  the author string's format.
- [ ] WHEN a signed-out user authors a capture THE SYSTEM SHALL behave exactly as
  it does today, using the git identity.

### Boundaries that must hold

- [ ] WHERE any organization data leaves the machine THE SYSTEM SHALL exclude
  context content, captures, prompts, credentials, absolute paths, and
  executable integration details.
- [ ] WHEN a user signs out THE SYSTEM SHALL retain every confirmed source and
  all local content, and SHALL only stop refreshing the directory.

## 6. What this explicitly does not give you

Membership grants **discovery, not access**. The directory says a repository
exists; whether you can clone it is decided by GitHub, using your own
credentials or a connected account.

WHEN confirmation fails because the repository cannot be read THE SYSTEM SHALL
say that organization membership does not grant repository access, and point at
the git host — not report a generic clone failure.

Under the GitHub-derived design these two boundaries mostly coincide, which is
much of why it was chosen: if you cannot read the organization's repository, you
cannot read its directory either.

## 7. Boundaries

- ✅ **Always:** validate a directory record on receipt as if its source were
  hostile; require local confirmation before anything becomes runnable; keep
  organization content below personal precedence; derive the acting user from
  the session, never from a request argument; keep signed-out mode fully
  functional.
- ⚠️ **Ask first:** adding a published source kind beyond the two git-clonable
  ones; introducing any server-side storage for the GitHub-derived path; giving
  the directory authority over a write path; automatic joining from an email
  domain; join codes (deferred by decision — see §8).
- 🚫 **Never:** Never commit secrets. Never route context, captures, prompts, or
  telemetry bodies through a server we operate. Never let a directory record
  carry a command, a credential, a credential alias, an absolute path, or an API
  host. Never let organization content outrank a member's personal context by
  default. Never grant a role or membership from a value supplied by the caller.
  Never auto-trust an executable source because an organization published it.

## 8. Deferred, with the decisions already made

These are not open questions; they are sequenced work with their answers fixed.

**Standalone organizations** (teams not on GitHub) arrive only when one asks.
They need what v1 avoids: our own organization and membership tables, row-level
security, and an authenticated write path. Members are added by **exact account
identifier** — no guessable secret exists in the system. Short-lived join codes
are a later addition, behind a flag, and only if onboarding friction proves
real; they would require high entropy, salted-hash storage, and a server-side
attempt throttle, none of which Postgres provides for free.

**The live team layer** stays out until read-only discovery has been used in
anger. Publishing a write path means an organization can inject unreviewed
context into every teammate's agent; that deserves its own spec.

**Entitlements, seats, and billing** remain deferred until payments exist
(`specs/contextcake-commerce/spec.md`), and must be server-authoritative when
they land — never read from a record the user can write.

## 9. Dependencies

- Sign-in must be shipping (`specs/contextcake-auth/spec.md`); today it is built
  and disabled behind `CC_ACCOUNTS=1`.
- The GitHub credential broker (PR #89, merged) supplies the host-bound token
  used to read organization membership, the directory file, and private repos.
- `docs/security/threat-model.md` §"Rules for work not yet done" is binding; the
  criteria in §5 are its testable form.
- `packages/core/src/resolver.mjs` decides precedence — the reason §5 states the
  clamp in terms of what resolves above what, rather than a bare number.

## 10. For the implementing agent

- **Commands:** engine and service tests from the repo root with `npm test` (the
  retrieval eval runs last and must not regress). Desktop with `cd apps/desktop
  && npm test`. Console with `cd apps/console && npm run typecheck && npm test`.
- **Structure:** the directory reader belongs in the desktop main process
  (`apps/desktop/src/main/`), beside `github-connections.mjs` — the engine stays
  dependency-free and never talks to an account service. Pending sources and
  materialization go through the engine's existing source API in
  `packages/core/src/service.mjs`; manifest validation stays the single
  chokepoint in `packages/core/src/manifest.mjs`. Console UI joins
  `apps/console/src/components/`.
- **Testing:** every SHALL NOT in §5 needs a negative test. At minimum: a record
  carrying `apiBase`, `command`, or `path` is discarded at receipt; a record
  pointing at another host is rejected; a sub-directory escaping the root is
  rejected; an organization source never wins a same-concept contest against a
  locally-added source at the default level; a pointer change returns a
  confirmed source to pending rather than re-pointing it.
- **Code style:** engine and desktop main are ESM `.mjs` in the engine's voice —
  comments explain why, not what. Console is TypeScript following existing
  component conventions.
- **Git:** conventional commits, one branch per phase, signed off with
  `git commit -s`.
- **Self-verification:** when the implementation is complete, compare the output
  against this spec and list any requirement not addressed.
