# How a section gets its date

**Rule:** never date a section by mtime in a git-backed layer, and never by
committer date. Where git genuinely cannot date a tracked file, leave the
section undated.

Dates are load-bearing. Staleness is surfaced through per-section `conflicts[]`
plus last-updated dates — the shadow/hash subsystem that used to detect drift
automatically was removed in the core re-arch (see
`specs/contextcake-core/design.md`). A date that reads fresher than the content
is therefore not a cosmetic bug; it silently reverses which side of a conflict a
reader trusts.

## The fallback chain

`withDocumentDate` in `packages/core/src/sources/okf-local.mjs` owns it, and
every other adapter shares it so section keys and dates agree across sources:

1. The authored `updated` field in frontmatter — always wins.
2. Otherwise a *content* date: git history for git-backed layers (`okf-local`,
   `github`), author dates, batched and TTL-memoized.
3. The file mtime **only** where no history can exist.
4. Otherwise nothing. An undated section is honest; a wrongly-dated one is not.

## Why not mtime

Git does not preserve mtimes. A fresh clone sets every file's mtime to checkout
time, so a teammate who just cloned the team layer would see every document
claiming it was written today — and every one of their own older personal notes
losing the freshness comparison against it.

## Why not committer date

`pull --rebase` rewrites committer dates. That is the exact operation team sync
performs on every pull, so committer dates would re-date the entire bundle on
the one flow the feature depends on. Author dates survive a rebase; that is why
they are the ones read.

## Why undated beats guessing

A shallow clone's boundary commit lists the entire tree as though it were
written at the boundary. There is no way to distinguish "written then" from
"truncated there", so the adapter declines to answer rather than borrowing a
date that reads as fresh.
