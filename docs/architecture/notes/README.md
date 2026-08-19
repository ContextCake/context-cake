# Architecture notes

Why a handful of non-obvious parts of the engine are built the way they are.

`CLAUDE.md` at the repo root carries the *rules* — short, imperative, loaded
into every agent session. These notes carry the *reasons*: the failure that
produced the rule, what was measured, and which alternatives were tried and
rejected. Split apart because the rules are read constantly and the reasons are
read once.

If you are about to change one of these subsystems, read its note first. If you
change one and the reasoning here goes stale, update the note in the same PR.

| Note | Covers |
|------|--------|
| [section-dating.md](section-dating.md) | Why a section's date comes from git author dates, never mtime or committer date |
| [index-keys-and-adoption.md](index-keys-and-adoption.md) | The three strings that name an index entry, and when a snapshot survives a change |
| [status-polling.md](status-polling.md) | Why clients poll `/api/status` and never `/api/graph` |
| [index-queue-and-memory.md](index-queue-and-memory.md) | Concurrency limits, the memory-pressure watermark, and the abort gap in remote adapters |
| [manifest-validation.md](manifest-validation.md) | Tolerant reads, strict writes, and the one repair door between them |
| [discrepancy-projection.md](discrepancy-projection.md) | One memoized discrepancy projection, what keys it, why candidates stay out of `revision`, and why live-layer decision writes go through git-core |
