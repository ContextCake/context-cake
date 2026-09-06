# Adversarial review — PR 155

The review covered the PR's engine, MCP, automatic policies, local-model transport,
console flows, and supporting documentation. Independent review passes examined
retrieval, policy/detection safety, and UI behavior. Findings were reproduced
before correction. No model output gained authority to change source files or
activate a policy.

## Findings addressed

| Priority | Finding | Correction and regression evidence |
| --- | --- | --- |
| P1 | The cache wrapper dropped document-cap warnings, allowing incomplete source coverage to appear eligible for automatic selection. | Preserve truncation notes on fresh, memory, and disk-backed listings. Cached-cap MCP tests verify policies remain blocked on repeated reads. |
| P2 | `get_links` outgoing links could disagree with the policy-selected content returned by `read_file`. | Apply the same recorded policy before extracting outgoing links. Tests cover active policy, Undo, and stale evidence. Incoming references remain explicitly labeled original source references. |
| P2 | A failed search refresh cleared the idle timer and could retain the previous parsed corpus indefinitely. | Rearm eviction when the last concurrent search settles, including failure; never rearm after close. Tests verify failed concurrent refreshes release retained content. |
| P2 | Malformed link destinations, wiki aliases, HTML openers, and unequal backtick runs caused repeated suffix scans. Bulk repair copied the whole document per match. | Index delimiter boundaries, bound searches to their spans, and assemble repairs once. Large malformed-input and 100,000-link exact rewrite/unlink regressions pass without syntax cutoffs. |
| P2 | An open Automation panel could retain stale history, or accept an older response over a newer one. | Refresh on corpus/discrepancy changes and cancel superseded requests. Tests cover background changes and delayed responses. |
| P2 | Advisory model results survived authored-date or coverage changes that did not change a discrepancy's content revision. | Bind displayed advice and pending requests to the complete evidence snapshot. Tests clear changed evidence and reject late responses. |
| P2 | Repeated next-match navigation skipped section matches sharing a reader page. | Track the last matched section rather than the page; test same-page, next-page, and wraparound navigation. |
| P2 | Source onboarding polled the full graph while waiting for an empty source to index. | Poll lightweight status; fetch the graph for a newly available document. Regression verifies repeated status requests cause zero graph requests until content exists. |
| P3 | Library result counts could imply all corpus matches were displayed. | State the 20-ranked-match limit beside source excerpt guidance. |

Console and contributor documentation now use Workspace, Library, and Trust
consistently, distinguish source-preserving policies from source edits, and
explain the actual link and reader contracts.

## Validation and limits

- Console: 42 suites / 763 tests passed after the review corrections.
- Targeted engine checks cover cache coverage, policy/MCP parity, failed-search
  eviction, remote cancellation, ranking compatibility, and lossless parsing.
- Parser differential checks preserve the previous supported delimiter behavior;
  large regression fixtures exercise paths that were previously unbounded.
- The full engine gate and final GitHub checks are required before merge; final
  results are recorded in the PR validation checklist.

No unresolved confirmed finding remains in the reviewed scope. This is not
qualification for autonomous semantic decisions: the local model remains
advisory, and incomplete evidence blocks automatic source-selection policies.
