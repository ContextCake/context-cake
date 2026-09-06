# Trustworthy automatic discrepancy resolution

Status: approved by the user, 2026-09-06. Extends the [performance and UX audit](../../docs/audits/2026-09-06-performance-and-ux.md). Implementation scope and outstanding qualification gates are recorded in [design.md](./design.md). This spec describes the target product; it is not a claim that every delivery stage has shipped or that any model establishes factual truth.

## Product objective

ContextCake should maintain useful, trustworthy project context with minimal recurring human work. Once a user enables a project policy, eligible discrepancies should be investigated, resolved, verified, and recorded automatically. The user should deal with a small set of exceptions that require knowledge or authority the system does not possess.

An LLM can interpret conflicting passages and identify the evidence needed to settle them. Neither model confidence nor agreement between models establishes which claim is true. The product must distinguish an answer selected by policy, a statement supported by evidence, and a claim whose truth remains unknown. Two sources agreeing can also both be wrong.

## Baseline before this implementation

- `control/discrepancies.mjs:runAutomaticRules` applies enabled automatic rules after a settled index pass. It checks coverage, health, rule conflicts, and current revision; rechecks under the manifest lock; bounds each batch; and records blocked attempts.
- Rules support preferring a source, acknowledging an intentional difference, and rewriting a specific broken-link target. Exact matching and constrained wildcards limit scope.
- `discrepancy-rules.mjs` learns suggestions from consistent manual decisions. Automatic outcomes deliberately do not count as evidence for more rules.
- Writes use staged transactions, journals, expected-content checks, and locked live-layer git mutations. Startup recovery exists. This is not yet a general user-facing Undo feature for every completed automatic decision.
- Acknowledgements preserve original conflicts in agent-visible output. Choosing a contribution currently writes the selected value into writable contributors. It must not be reused silently as a non-destructive resolution mechanism.
- Detection is structural and primarily compares aligned concepts/sections/fields. Semantic contradictions across different documents and identifiers are a separate missing detection capability.

This approved spec adds advisory model assessment of existing structural discrepancies to the discrepancy-center scope. Model-inferred cross-document contradiction detection remains a later, separately evaluated stage. The original discrepancy-center scope does not silently gain semantic detection or model-authorized writes.

## Proposed user experience

In Review, offer **Automatic resolution** when there is relevant work. Explain the scope and destination of changes in the same place as the enable action.

1. Choose a project and permitted sources/actions.
2. Choose **Run on this Mac**, **Use an existing local model**, **Use an API key**, or a supported subscription integration.
3. Show an initial read-only assessment: eligible fixes, unresolved items, expected resource/cost limits, and example evidence.
4. Enable the policy once. Subsequent eligible decisions run without a per-item confirmation.
5. Provide a quiet history of what changed, evidence, why the policy allowed it, and Undo/Pause controls. Notify for failed verification or an important unresolved decision rather than for every routine fix.

Working default while the user chooses the write policy: allow project-specific settings and preserve original files by applying supported decisions to ContextCake's resolved view. Source-file repair is a separately enabled action class. A resolution that changes what an agent sees is still consequential even if it edits no original file; it goes through the same validation and audit path.

User-facing states should be explicit: **Automatically resolved**, **Selected by project policy**, **Different scopes**, **Needs evidence**, **Changed since resolution**, and **Fix failed**. Acknowledged does not mean verified correct; fewer open alerts is not evidence of better knowledge.

## What can run unattended

| Case | Autonomous behavior | Required basis |
| --- | --- | --- |
| Whitespace or unordered-bullet formatting difference | Ignore as equivalent, without editing source files | Existing narrow deterministic normalization |
| Link syntax inside a documentation code example | Exclude from link findings | Markdown-aware span parsing; repair detector before adding model judgement |
| Link to a renamed concept | Repair under enabled policy | Explicit rename/alias evidence with one extant destination, fresh source snapshot, correct scope; string similarity alone is insufficient |
| Two values with different explicit environments | Preserve both and select the relevant value for the active project/environment | Machine-readable scope plus policy; model can propose missing scope but cannot turn a guess into established metadata |
| Approved decision explicitly supersedes an older one | Select the successor and retain history | Valid supersedes relationship and configured authority; a newer timestamp alone is insufficient |
| An exact source preference already enabled by the user | Apply the policy and label the outcome as policy-selected | Existing rule guards, fresh evidence and authorized write scope |
| Paraphrases that might mean the same thing | Model-assisted assessment; automatic disposition only for separately evaluated, enabled categories | Grounding and contradiction checks with measured precision; all source versions remain accessible |
| Sources disagree on production settings without deciding evidence | Retrieve relevant approved evidence; otherwise abstain and preserve the conflict | No fabricated winner, no inference that lower rank means factually false |
| Reconciled prose introduces new claims or loses qualifiers | Keep as a proposal; advanced automation is a later release gate | Claim-by-claim evidence coverage and category-specific evaluation, not another model saying “looks good” |

The first release can perform real automatic work without relying on a model for facts it cannot establish. Broader model-based decisions become eligible by category as evaluation supports them; enabling an LLM must not implicitly authorize every possible edit.

## Decision pipeline

1. **Detect and prioritize.** Begin with structural discrepancies. Later, use bounded retrieval to find candidate contradictions across differently named concepts; avoid all-pairs LLM comparisons. A missed candidate is a detection error, measured separately from adjudication accuracy.
2. **Build an evidence packet.** Pin project/profile, discrepancy kind and exact ID, section/field/target, raw contributor hashes, source identities, authored dates, explicit authority/scope, coverage status, nearby definitions, and relevant decisions. Preserve negation, code, units, and qualifications. Missing or truncated evidence makes the packet incomplete.
3. **Assess.** The model gets evidence as untrusted data and returns a schema-validated proposal: category, suggested existing action, selected evidence references, concise rationale, missing evidence, and abstention reason. It receives no filesystem, shell, write, or unrestricted network tools. Record a decision rationale, not hidden reasoning traces.
4. **Validate policy and evidence.** Verify cited spans really exist in the pinned inputs, targets are valid, the action is enabled for these sources, and explicit authority/scope requirements hold. Citation presence, schema validity, low temperature, and two-model agreement are not semantic proofs. Semantic categories need their own empirical release gates.
5. **Dry-run and apply.** Recheck the full evidence fingerprint and policy version immediately before application. Call shared control operations through the existing transaction and live-repo locking path. Model inference happens outside manifest/git locks. No provider gets a direct write capability.
6. **Verify the result.** Re-resolve and check the action-specific postcondition, preservation of unrelated content, provenance, and invariants. Commit a durable disposition only after verification. On failure, restore transaction-owned changes when still safe; if a subsequent edit prevents reversal, block and report recovery instead of overwriting it.
7. **Invalidate on change.** A change to contributors, evidence dependencies, scope, authority, policy, or applicable model qualification makes the previous outcome stale. Stop serving a stale model resolution as current and schedule reassessment. Disabling a policy prevents queued writes too.

Cache assessments by the complete evidence packet hash, project/profile, action policy, model digest/provider version, prompt/schema/validator versions, and evaluation qualification. Cache invalidation must cover retrieved supporting evidence as well as the two conflicting excerpts.

## Preserve sources with a resolution record

A new non-destructive decision representation is needed; the current choose-contribution writer can modify every writable contributor.

- Store the decision beside profile-scoped sidecar state with stable identity, evidence dependencies, previous outcome, action, destination, author/method, versions, validation results, and timestamps.
- Prefer a reference to an existing contribution over generated replacement prose.
- Apply only to the specified concept/section or field while inputs remain current. Never implement this as a blanket highest-precedence generated source.
- Return the effective value with additive provenance and disposition in both HTTP and MCP. Preserve dissent and original content. Distinguish generated text from human-authored evidence.
- Make completed-decision Undo an explicit compensating transaction, guarded against intervening user edits. Crash recovery and Undo are distinct workflows.
- Do not allow machine decisions to become fresh independent evidence for their own correctness, train automatic rules from themselves, or refresh their authority just by being rewritten.
- Source repair can be enabled for narrow paths/actions later. A team-shared write needs an explicit shared policy and ownership decision; enabling local automation never silently enables it for teammates.

## Model and provider strategy

Keep a provider-neutral assessment contract. The dependency-free engine owns evidence, validation, and decisions; the desktop host owns model lifecycle, keys, provider communication, and scheduling. SDK dependencies, if used, remain outside `packages/core`.

### Local

Prototype against existing Ollama or LM Studio installations first. Ollama supports schema-constrained responses; this supplies a parseable transport contract, not factual correctness. [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs)

Then offer a managed **Set up local model** flow: inspect compatible hardware and available disk/RAM, choose an evaluated model/quantization, explain download size and measured memory needs, obtain installation consent, download a pinned artifact from an official source, verify it, run a local capability check, and expose cancellation/removal. Support license and runtime notices. No unverified universal model-size recommendation or promise of a dialog-free install on every Mac.

Load on demand and unload when idle. Limit concurrency and pause/back off when indexing or interactive work needs resources. Ollama exposes keep-alive controls; LM Studio documents idle TTL and auto-eviction. Existing user-managed runtimes must not have their unrelated sessions or models unloaded by ContextCake. [Ollama FAQ](https://docs.ollama.com/faq), [LM Studio lifecycle controls](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict)

At proposal time, an Ollama executable and LM Studio app were present, but sandboxed probes had not verified server readiness or installed models. The subsequent implementation tested an existing local model; see [the development smoke results](./design.md#evaluation-and-remaining-gates). Managed installation remains a later stage.

Select model versions by held-out discrepancy evaluations, hardware cost, and refusal behavior. A small model may handle classification and evidence extraction; it must earn authority for each automatic action class. Quantization, prompts, context limits, or model updates trigger requalification.

### Remote API

Offer an explicit provider choice with credentials kept by the desktop host, allowed source scopes, per-run/daily spending limits, timeouts, bounded retries, and content disclosure. Send only the evidence needed. Local-only mode has no silent remote fallback. Provider failure defers work without changing facts or treating partial model output as a decision.

### Existing subscriptions

Build provider-specific supported integrations, not generic credential reuse. Anthropic's current help page says Agent SDK, `claude -p`, and third-party app usage continue drawing on subscription limits while a previously announced billing change is paused; verify SDK authentication/distribution requirements and current limits before shipping. [Claude subscription and Agent SDK usage](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

A ChatGPT subscription is separate from generic OpenAI API billing. Any supported subscription-backed client integration is a separate adapter to validate, not an API key obtained from the chat subscription. [OpenAI billing distinction](https://help.openai.com/en/articles/9039756)

## Reliability evaluation before autonomous rollout

Maintain labeled cases from real repositories, with train/development/holdout separation by project or document family. Near-duplicate excerpts must not leak across splits. Label the permissible action set and expected abstention as well as the apparent winner.

Required cases include code examples, ambiguous renames, conflicting numeric values/units, negation, prod/dev differences, temporary migrations, obsolete but recently edited docs, explicit supersession, missing authority, mutually wrong sources, source outages, long/truncated evidence, cross-profile overlap, prompt injection in documents, forged citations, and contradictory rules.

Report separately:

- Candidate-detection recall, including cross-concept cases.
- Correctness among actions actually applied; wrong automatic selection and destructive edits by severity/category.
- Useful automation coverage and abstention rate, so a system that refuses everything cannot appear successful.
- Evidence entailment and qualifier preservation; real-world factual accuracy only where authoritative labels exist.
- Reopening, oscillation, correction, rollback, and repeated-failure rates.
- Warm/cold assessment latency, peak memory, idle impact, tokens, and cost per useful resolution.

Release gates: no unauthorized writes, no cross-profile mutations, no successful prompt-injection actions, no ungrounded cited spans, no applying stale evidence, and no source loss in crash/concurrent-edit tests. For semantic categories, predeclare an acceptable error budget and report statistical uncertainty using sufficient independent held-out cases. Zero observed mistakes on a small suite does not establish zero risk. A second LLM may help review; it is not the sole oracle.

Start with a no-write shadow run, inspect disagreement with reference labels, then enable narrowly scoped automatic actions. Audit samples and user reversals remain evaluation feedback. A model/provider/policy change does not inherit qualification without checking it. Stop the affected action class when error or recovery thresholds trip.

## Delivery sequence

1. **Reliable detection and action contracts:** repair code-example false positives, build labeled cases, define authority/scope and output contracts, preserve current no-model automation.
2. **Read-only assessment:** one local adapter and one optional hosted adapter, evidence packets, strict schemas, cache keys, bounded scheduling, shadow reports. Model never writes.
3. **Verified automatic outcomes:** profile-scoped resolution records, current-evidence guards, action-specific verification, Undo, history, pause/kill switch, and HTTP/MCP parity. Enable qualified policies without per-item approval.
4. **Managed setup and broader semantics:** hardware-qualified model installation, provider-specific subscription adapters, bounded cross-document detection, and additional action classes only as their evaluations pass.

Success means less recurring review work and fewer incorrect answers passed to agents. It does not mean every disagreement vanishes or a model turns unsupported knowledge into verified truth.
