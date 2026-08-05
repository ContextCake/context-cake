# The update channel

The Mac app downloads and installs signed code on its own. Whoever controls
what it downloads controls every installation. This is the largest single
security surface in the product, larger than any credential it holds, so it
gets its own document.

Reviewed 2026-08-04 against `apps/desktop/src/main/updater.mjs`,
`apps/desktop/electron-builder.yml`, and `.github/workflows/app-release.yml`.

## How it works

The packaged app checks `github.com/ContextCake/context-cake/releases/latest`
at launch and every six hours, using electron-updater's GitHub provider. It
downloads in the background and installs on quit. The check is switchable
(Settings → General) and never runs in development builds.

A release is produced only by `app-release.yml`, triggered by pushing an
`app-v*` tag. That workflow refuses to continue unless:

- the tagged commit is an ancestor of `main`;
- the tag version equals `apps/desktop/package.json`;
- no `## Open:` gate remains in `docs/release-gates.md`;
- signing and notarization secrets are all present — otherwise it builds
  unsigned and **publishes nothing**.

Before publishing it runs `codesign --verify --deep --strict`, `spctl -a -vv -t
install`, and `xcrun stapler validate` against the built app. Those are real
checks and they run on every release.

That is a better pipeline than most projects this size have. The findings below
are about what sits outside it.

One qualification on the first bullet, because it is easy to read as more than
it is. The ruleset on `main` enforces deletion and non-fast-forward protection
only — there is no required review and no required status check — and
`app-release.yml` does not run the test suite. "An ancestor of `main`" therefore
means the commit was on `main` at some point, not that anyone reviewed it or
that its tests passed. Adding a required check-runs gate to the release job
would close the gap between what that line implies and what it enforces.

## Findings

### 1. The gates are on the workflow, not on the release — high

Every control above lives inside `app-release.yml`. Nothing requires a release
to come from `app-release.yml`.

Anyone with write access can create a GitHub Release by hand, attach a
`latest-mac.yml` and a zip, and every installed app will fetch it at the next
check. Release assets are also editable after publication, so an existing
release can be altered rather than replaced.

The tag-on-main check constrains *what code* ships. It does not constrain *who
ships* or *what artifact* is attached.

What this does **not** buy an attacker is arbitrary code execution. Squirrel.Mac
refuses a bundle whose signature fails the installed app's designated
requirement, so a replacement artifact still has to be signed by the same
Developer ID. Repository write alone is not enough; the certificate is a second,
separate thing to steal. That control is also the only artifact-level check on
this path — electron-updater performs no macOS signature verification of its
own — which makes a Team ID change something that would silently break updates
for every existing install.

**Rollback is the sharp version of this.** An attacker with release write does
not need to forge anything: they declare a high version in `latest-mac.yml` and
attach an *older, genuinely signed* build. The hash matches, because they wrote
the file that states it. Squirrel.Mac accepts it, because it really is the same
Developer ID. Every installation silently downgrades to code with known
vulnerabilities, and the update system reports success. Same precondition as
above, so not a separate hole — but it is what makes the hole worth closing.

**Fix:** restrict who may publish releases, add build provenance (below), and
refuse to apply an update whose version is not strictly greater than the highest
version this installation has seen — a `semver` comparison and a stored floor in
`initUpdater`.

### 2. Tags are unprotected — high

The repository has one ruleset, targeting branches (`protect main`). There are
**zero rulesets targeting tags**. Creating an `app-v*` tag is what starts a
signed, published, auto-installed release, and nothing restricts creating one.

**Fix:** a tag ruleset for `app-v*` restricting creation to the release
process or to named actors. This is a repository setting, not a code change.

### 3. A silent update channel is a broken one — medium

`initUpdater` swallows failures into `console.error`. Nothing in the interface
says the app has stopped being able to update itself.

That matters because a known constraint makes silent failure likely:
electron-updater's GitHub provider reads the *repository-wide* `latest`
release, so publishing any non-app release (a `console-v*` tag, for instance)
makes `latest-mac.yml` 404 and every check fail. The code comments this and
compensates with a convention — only `app-release.yml` may publish full
releases; other release notes must be drafts or prereleases.

A convention enforced by memory is the same class of control that let the
hosted-OAuth gates slip through three releases. If the update channel breaks,
security fixes stop arriving, and today nobody would learn that from the app.

**Fix:** surface repeated check failures in the interface, and prefer a
dedicated feed over the repository-wide `latest` when one is available.

### 4. No build provenance — medium

The workflow does not attest its artifacts. With
`actions/attest-build-provenance`, anyone could verify that a given `.dmg` was
produced by this workflow, from this commit, on GitHub's runners. Without it,
the only provenance is the Developer ID signature — and that same identity is
what a compromised runner or a stolen certificate would produce.

Signing proves *who built it* only as far as the key is uncontrolled. Provenance
proves *how it was built*, which is the property that survives a stolen key.

**Fix:** add attestation to the release job and document the verification
command for users who want it.

### 5. The signing runner installs vulnerable build dependencies — medium

Open Dependabot alerts, all in `apps/desktop/package-lock.json`:

| Package | Installed | Patched in | Reached through |
|---|---|---|---|
| `fast-uri` | 3.1.3 | 3.1.5 | `ajv` |
| `undici` | 7.28.0 | 7.29.0 | `@electron/get` |
| `undici` | 6.27.0 | 6.28.0 | `node-gyp` |

**These do not ship.** All three are `dev` dependencies; the packaged app does
not contain them, and Electron's `fetch` is its own built-in rather than this
`undici`. The claim that a vulnerable HTTP client reaches users would be wrong.

They matter for a different reason: they are installed and executed on the
runner that holds the signing certificate and the notary key, during the job
that produces the artifact users auto-install. A build-chain compromise there
is worse than a runtime one, because its output is signed.

**Corrected 2026-08-05.** An earlier draft of this page said "PR #90 was
intended to close these and the alerts remain open," implying the fix had not
been attempted. The real history is worse and more instructive: #90 *did* raise
all three pins. PR #89 merged nineteen minutes later carrying a lockfile cut
before both #90 and the 0.4.0 version bump, which reverted the pins and left the
lockfile root at 0.3.0 against a `package.json` of 0.4.0. `npm ci` accepts that
mismatch silently, and the release workflow compares the tag against
`package.json` only — so a release could have been built from a lockfile
describing a different version of the app. Dependabot re-opened the alerts, but
a re-opened alert reads like noise beside a merged PR titled "patch undici and
fast-uri."

Fixed in PR #95: pins restored, `npm audit` clean at zero across the tree, and
two CI guards — the desktop lockfile root version must equal `package.json`, and
`npm audit --omit=dev --audit-level=high` runs on the packages that ship.

**Remaining fix:** treat the release job's dependency tree as security-relevant
in its own right rather than as developer tooling. "Raise the pins" was never
the durable answer; a guard that fails the build is.

### 6. `SHA256SUMS` does not protect the auto-update path — low

The workflow publishes checksums, which is useful for someone verifying a manual
download. The updater does not consult them; it trusts `latest-mac.yml` and the
code signature. Worth stating so the file is not mistaken for a control on the
automatic path.

### 7. One person is the whole trust chain — low, structural

The repository has a single collaborator with admin rights. That account can
push to `main`, create tags, publish releases, and administer the settings that
would otherwise constrain any of it. Compromise of that one account is
compromise of the update channel for every install.

This is normal for a project this size and not a defect. It does mean the
protections worth having are the ones that survive account compromise —
hardware-backed second factor, and provenance that a stolen signing key alone
cannot forge.

## What the user cannot do

Stated plainly, because it bounds everything above: there is no per-update
consent. `autoDownload` and `autoInstallOnAppQuit` are both on, so an update is
fetched and applied without the user seeing it. Turning off update checks
entirely is the only control they have.

That is a reasonable default for a security-updating product, and it is exactly
why findings 1 and 2 rank as high rather than medium.

## Priority

1. Tag ruleset for `app-v*`, and restrict who may publish releases (settings).
2. Build provenance attestation in the release job.
3. Raise the vulnerable build-chain pins and keep the release job's tree clean.
4. Surface repeated update-check failures in the interface.

The first two change what an attacker must compromise from *one account* to
*one account plus GitHub's own signing of provenance*. Nothing else on this list
moves the needle as far.

## Related

- [Threat model](./threat-model.md) — where this sits among the other risks
- [Secret rotation](./secret-rotation.md) — the signing identity and its custody
- [Network egress](./egress-allowlist.md) — the hosts involved in an update
