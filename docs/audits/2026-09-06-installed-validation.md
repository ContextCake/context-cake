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

## Second UI revision

After the user's follow-up, Home was reorganized around one prominent search field, small inline totals, a compact attention state and a source-health list. Cascade details use a disclosure, and agent connection is a secondary action. This removes repeated source rows and the competing colored banner.

Knowledge uses a wider result rail, flatter rows with less repeated metadata, wrapping 15px titles and 15px Markdown at a bounded reading measure. The native system font remains consistent across controls and content. Row heights account for excerpts, identifiers and longer titles while retaining windowing and keyboard navigation.

Review omits zero-count tiles and irrelevant filters in the default all-clear view. History tabs remain available; selecting a historical status restores filtering. Empty results no longer occupy a tall bordered card or direct an already-selected Needs review tab back to itself.

Installed checks covered real sources, light/dark appearance, narrower native windows, two-pane to single-pane reader behavior and focus restoration on Close. The original dark appearance was restored. All 746 console tests, typecheck and packaged live build passed. No engine, model transport, policy or source-data behavior changed in this UI revision.

## Holistic workbench redesign

The final local installation uses renderer `index-DnZUB8oL.js` (436.71 kB,
129.44 kB gzip). Its Workspace, Library and Trust layouts were rebuilt around
search, reading and evidence. The compact labelled rail is enabled; the user's
GitHub Dark theme and comfortable density are retained.

Native checks covered:

- All 255 concepts and the two real source connections loaded after replacement.
- Library Command-F search for `conflict resolution`, real results and resolved
  document content, source attribution and matching-section navigation.
- The 439-section document remained paginated; reader and result panes scroll
  independently. Narrowing the native window switches to a detail sheet; Escape
  returns focus to results. Sources' inspector also remains reachable at that width.
- Light appearance was inspected, then the original dark appearance restored.
- Trust's 17 acknowledged records remained visible. Single-item groups expose
  their item immediately; Automation opens its policy controls in one click.
- The source manifest retains SHA-256
  `55dd1dba3295368ee6f697e3a4e6e1d488ed17a1f19313c208959d35fe978f50`.

Real-app findings corrected before final installation: the Workspace preview now
fills six rows even when few documents have loaded dates; its breakpoints use
available content width; a focus-stealing introductory Trust overlay was removed;
single-item groups no longer require expansion; source names use the shared UI
font. No new semantic-model capability or reliability claim is introduced.

Validation: 42 console suites / 757 tests, typecheck, live build, 128 desktop tests,
and ad-hoc signature verification passed. Independent parallel layout/type
assessments and mechanical scans informed the redesign; native screenshots and
interaction checks supplied the final visual verification. Private screenshots
remain excluded from the repository.
