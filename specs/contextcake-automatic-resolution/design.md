# Automatic resolution: first implementation

Approved direction: September 6, 2026. This implementation delivers exact source-preserving section policies and a local advisory assessment path. It does not qualify semantic automation or install a managed model.

## Behavior and authority

In Trust → Automation → Automatic context resolution, the developer chooses one exact concept, section and contributing source. Enabling that policy selects the existing contribution now and after future changes to that section, once all sources have settled. Original files remain unchanged. Original dissent stays visible to humans and MCP clients. Selection by policy is distinguished from verified factual correctness.

Policies and decisions live in `.contextcake/profiles/<id>/context-resolutions.json` beside the manifest. The schema records policy version, profile, exact concept/section/source, selected manifest fingerprint, current contributor evidence fingerprint, and timestamps. Atomic replacement under the manifest lock makes each policy and decision durable together. There are no source writes or live-layer git operations on this path.

Evidence includes each contributor's exact content, source name, precedence and authored date. Policies stop applying when evidence changes until revalidated; source configuration changes require renewed consent. Incomplete, warning-bearing, failed or moving coverage cannot authorize new decisions. Conflicting legacy authority blocks selection. A paused policy immediately stops affecting subsequent reads. Undo marks the latest decision undone and pauses its policy, so the next indexing pass cannot instantly recreate it. Older decisions cannot undo a newer decision.

Control operations recheck live content under a bounded validation deadline inside the shared manifest lock. Inference runs outside locks. Read APIs decorate copies of raw resolver output; neither cached snapshots nor discrepancy evidence contain previously selected outputs. Prepared lookups keep application linear in history plus section count. HTTP and MCP share the decision application and legacy-authority matching code.

The default-profile desktop service remains default-profile scoped. A standalone MCP process reads only its selected profile's decisions. This release does not add a desktop project-profile switcher or standalone MCP background policy writer.

## Additive APIs

| Route | Contract |
| --- | --- |
| `GET /api/context-resolutions` | Versioned policies and decision history for the service profile; each decision includes `currentStatus` and `currentRevision`. The UI requires that revision to match the displayed discrepancy before marking it handled. |
| `POST /api/context-resolutions` | Enable exact `{conceptId,key,selectedSource,revision}` policy; revision is the reviewed discrepancy revision. |
| `PATCH /api/context-resolutions` | Pause `{policyId}`. |
| `DELETE /api/context-resolutions` | Undo latest `{decisionId}` and pause its policy. |
| `GET /api/discrepancy-assessment/models` | Discover installed local models through a desktop-owned provider. No provider means unavailable. |
| `POST /api/discrepancy-assessment` | Assess `{discrepancyId,revision,model,digest}` without changing sources, policies or decisions. |

All routes share the service's bearer and mutation guards. No assessment capability is exposed as an MCP write tool. Resolved sections add `contextResolution` with `decisionId`, `policyId`, `selectedSource` and `applied`, `stale` or `undone` status. Existing source-writing discrepancy actions retain their original behavior and remain separate.

## Local assessment

The dependency-free core owns evidence packets and strict output validation. The desktop owns the Ollama adapter and injects it into its engine host. It talks only to `127.0.0.1:11434`, rejects redirects and known remote/cloud models, requires installed completion capability, checks the chosen model digest before and after inference, and exposes no tools. It does not download models or reuse credentials.

Requests are on demand, single-flight, with a 45-second provider timeout, bounded response size, 8,192-token context request, 1,200-token output limit and one-minute keep-alive. Evidence exceeding 12 KB is refused. The adapter requires Ollama 0.15.4 or newer and sends `truncate:false` and `shift:false`, so context overflow must fail rather than silently discard evidence. These fields are present in the [v0.15.4 request contract](https://github.com/ollama/ollama/blob/v0.15.4/api/types.go). A user-managed local Ollama runtime remains within the local trust boundary; ContextCake cannot attest to a modified runtime's internal behavior.

Output must match a strict schema. Every quote must occur verbatim in its named source; compared contributions must be cited unless the model abstains. A source suggestion while reporting missing evidence is rejected. Evidence is reread after inference, and changed evidence discards the answer. These checks establish structural grounding, not entailment or truth. All accepted outputs explicitly carry `advisoryOnly:true` and `automaticallyApplicable:false`; the UI never copies a suggestion into an enabled policy.

Transport follows [Ollama's chat API](https://docs.ollama.com/api/chat) and [structured-output contract](https://docs.ollama.com/capabilities/structured-outputs).

## Evaluation and remaining gates

The committed six-case synthetic development smoke set covers environment scope, conflicting numbers, negation, an injected instruction, unit equivalence and misleading recency. It is not a held-out dataset or sufficient qualification. `node packages/core/eval/assess-local.mjs <installed-model> <report-path>` runs it without source writes.

The first run against installed `qwen2.5:7b` passed 4/6 expected outcomes. It suggested an unsupported source on the adversarial case and missed that 60 seconds equals one minute. The preserved [raw report](../../docs/audits/2026-09-06-local-model-development.json) predates the additional missing-evidence/citation validation guards; it is evidence of model limitations, not a claim about the final validator's accepted-response rate. No outcome was applied. Local assessment took roughly 6–19 seconds per case on this machine.

Remaining stages from the approved target spec:

- Project-separated, independently labeled development/holdout corpora with action precision, useful coverage and statistical uncertainty.
- Hosted providers with explicit source scopes, protected credentials and spending limits; provider-specific supported subscription adapters.
- Hardware-qualified, cancellable managed model installation and removal with verified artifacts and license notices.
- Cross-document semantic candidate detection, explicit authority/supersession records, and additional independently qualified action classes.
- User-authorized source-editing automation, action-specific verified postconditions and general undo for those edits.
- Desktop project-profile switching, useful retrieval adoption metrics and capture reuse feedback from the performance/engagement audit.

These gates remain explicit. Passing deterministic tests does not authorize a model to select the truth automatically.
