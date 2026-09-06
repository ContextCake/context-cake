# Installed Mac app validation — September 6, 2026

Validation used the actual `/Applications/ContextCake.app`, rebuilt from the implementation branch and ad-hoc signed for local use. This is a development installation, not a published or notarized product release. The prior application and configuration were backed up before replacement.

## Real-source checks

- The two existing sources loaded 255 concepts with their configured precedence. Existing settings and 17 acknowledged discrepancy records were preserved.
- Four baseline false broken-link alerts disappeared after the Markdown-aware parser fix.
- The real 439-section document rendered as safe Markdown with 20-section pagination; navigation remained usable.
- The native Settings shortcut opened the separate settings window. General and Indexing layouts were inspected in the installed app.

## Controlled automatic-resolution checks

Two temporary local folders each contributed one `validation/installed-check` concept. One specified PostgreSQL and the other SQLite; inline code contained a deliberately nonexistent wiki link.

- Exactly one section-content discrepancy appeared; the code example did not generate a broken-link alert.
- Installed local completion models were discovered. Qwen 2.5 7B returned a cited, conflicting advisory result without changing source selection or policies. Its narrative incorrectly described source priorities as equal, reinforcing that the advisory output is not qualified as autonomous authority.
- Enabling an exact section policy selected the secondary source's SQLite answer. Review moved from one actionable item to zero and showed one resolved item. Original files and pre-existing review history were byte-identical.
- Editing only the synthetic trusted document to SQLite 3 automatically produced a new decision. The reader showed SQLite 3, identified the applied source policy, and preserved PostgreSQL as dissent. No second approval was required.
- Undo paused the policy, marked the latest decision undone, restored the primary cascade answer and reopened the actionable item.
- Both temporary source registrations were removed through the UI. Original manifest bytes and levels were restored after checking that only test-induced level changes remained. Only the synthetic policy/history sidecar was removed; existing acknowledgement history was hash-verified unchanged.

## Defects found and corrected

| Installed observation | Correction and regression |
| --- | --- |
| Home and Ask could navigate to Knowledge but drop the query | Atomic guarded destination-search action; form, quick-search and Ask tests |
| A source filter returned zero even when matching documents existed outside the global top 20 | Source/type matching before top-k; HTTP fixture with 25 higher-ranked distracting documents |
| Raw source snippet could contradict the current policy-selected reader answer without explanation | Explicit original-source excerpt label and current-resolved-context guidance |
| Snippet cleanup could erase TypeScript generics or command placeholders | Preserve angle-bracket text using React escaping; generic/placeholder regression |
| Source success retained static indexing text after ready | Keep dynamic progress and remove stale static copy |
| Initial search left the reader pane blank | Quiet choose-a-result guidance without automatic selection or extra requests |
| Local package displayed raw missing `app-update.yml` error | Unsupported local-build update state; production metadata path stays unchanged |

Private knowledge excerpts and screenshots are intentionally excluded from this repository record. The local model received only the controlled synthetic conflict for this check.

## Final installed recheck

The corrected installed build preserved Home form, quick-search and Ask queries when opening Knowledge. The same `build and test` query that previously returned zero when scoped to the specifications source now returned 20 scoped results. Result excerpts explicitly identify original source text; selecting a result shows rendered Markdown and section navigation. Settings now reports updates unavailable for the local development build while preserving the automatic-update preference.

The final source state is two healthy sources, 255 concepts, zero actionable discrepancies and 17 preserved acknowledgements. Automated verification: 58/58 engine suites, 42/746 console tests with typecheck/build, and 128 desktop tests on Node 22.
