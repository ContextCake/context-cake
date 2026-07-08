# Team Context Radar — Architecture Handoff

**Date:** 2026-06-18  
**Status:** Product direction revised, MVP implementation started  
**For:** Codex / autonomous agent to implement

---

## The Goal

Build a shared AI context-management system for a professional engineering team of 10-15 people operating across five active repos.

The system should be easy to explain:

> Team Context Radar watches the work already happening in our repos, turns important patterns into durable team context, and only asks humans to review risky or ambiguous updates.

It should not become "another docs repo" that everyone has to babysit. The shared repo is the storage substrate, not the daily workflow. The daily workflow is a small control surface that shows:

- what was captured automatically
- what needs review
- what context is stale, missing, or repeatedly requested
- which repos have weak coverage

---

## Product Principles

1. **Work in the repos you already use.** No mandatory new authoring habit.
2. **Capture from signals, not memory theater.** PRs, commits, incidents, deploys, issues, and repeated questions are better inputs than blank-page docs.
3. **Default to automatic storage.** Human review is reserved for risk, ambiguity, ownership conflicts, or external commitments.
4. **Stable knowledge is small.** Store durable decisions, systems, runbooks, interfaces, incident learnings, and onboarding answers; ignore routine churn.
5. **The UI is the product surface.** The shared repo is implementation detail for versioning and permissions.

---

## Architecture Decision: Watch Five Repos, Store One Shared Knowledge Base

**NOT:** a manually maintained docs repo  
**NOT:** a single partitioned graph database  
**YES:** repo activity → classifier → shared OKF store → MCP + control surface

```
SIGNAL LAYER
────────────────────────────────────────────
Five existing engineering repos
  ├── merged PRs
  ├── changed files
  ├── issue labels
  ├── deploy notes
  ├── incident notes
  └── repeated agent questions

ROUTING LAYER
────────────────────────────────────────────
Context classifier
  ├── ignore routine churn
  ├── store stable facts automatically
  ├── create candidate updates
  └── flag risky/ambiguous changes for review

KNOWLEDGE LAYER
────────────────────────────────────────────
Shared OKF repo
  ├── systems/        ← how services work
  ├── decisions/      ← durable architecture choices
  ├── runbooks/       ← operational procedures
  ├── interfaces/     ← cross-repo contracts
  └── index.md

ACCESS LAYER
────────────────────────────────────────────
MCP server + visual control surface
  ├── agent search/read access
  ├── review queue
  ├── coverage view
  └── stale/missing context alerts
```

---

## Context Routing Model

Every captured signal gets one route:

| Route | Meaning | Review? |
|---|---|---|
| `ignore` | Routine implementation detail, dependency churn, formatting, local refactor | No |
| `local` | Useful for the author/agent session but not team durable | No |
| `team_candidate` | Likely durable team context; safe to draft/store automatically | Usually no |
| `review_required` | Risky, ambiguous, sensitive, or cross-team consequential | Yes |

Review is required for:

- auth, security, privacy, payments, customer data, credentials
- public API or cross-repo contract changes
- incident learnings with unclear ownership
- personal/private notes being promoted
- conflicting or low-confidence summaries
- anything that changes what another team must do

Automatic storage is allowed for:

- merged PRs labeled `architecture`, `runbook`, `context`, or `decision`
- incident fixes with clear repo ownership and no sensitive content
- repeated Q&A where the same question appears 3+ times
- stable cross-repo dependency facts
- onboarding answers already visible in public team repos

MVP policy: `tools/team-knowledge/context-policy.json`  
MVP classifier: `tools/team-knowledge/classify-context.mjs`

---

## File Format: Open Knowledge Format (OKF)

OKF was announced by Google Cloud on 2026-06-12. It formalizes the Karpathy LLM-Wiki pattern into a portable, vendor-neutral spec.

- A **bundle** = a directory of markdown files with YAML frontmatter
- Each file = one concept; file path (minus `.md`) = concept ID
- **Only required frontmatter field:** `type`
- Markdown links between files = graph edges
- Stored in git, editable in any editor, no required SDK

Example file:
```markdown
---
type: system
title: Auth Service
tags: [auth, backend]
---

# Auth Service

Handles JWT issuance and validation. See also [API Gateway](systems/api-gateway.md).
```

Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog (Apache 2.0)

---

## What to Build

### 1. Context Classifier

A small policy-driven router that accepts repo events and returns:

- route
- confidence
- reasons
- recommended action
- whether review is required

MVP implementation: `tools/team-knowledge/classify-context.mjs`

### 2. Control Surface

A local visual dashboard for the team lead/platform owner:

- attention queue
- auto-captured context feed
- repo coverage
- routing policy summary
- stale/missing context alerts

MVP implementation: `tools/team-knowledge/control-surface/index.html`

### 3. MCP Server

The MCP server gives agents read access to the shared store and optional personal context:

- `search`
- `read_file`
- `list_concepts`
- `get_links`

MVP implementation: `tools/team-knowledge/mcp-server.mjs`

### 4. Promotion Script

`promote.sh <file-path>`

- Copies a file from personal bundle → shared bundle
- Rewrites any personal-namespace links to shared-namespace links
- Opens a PR (or prints the git commands to do so)
- Updates `index.md` in the shared bundle

MVP implementation: `tools/team-knowledge/promote.mjs`

### 5. Setup/Onboarding Script

`setup-knowledge.sh`

- Clones the shared team repo
- Creates the personal dir structure
- Writes the MCP server config (pointing at both dirs)
- Adds the MCP server to `~/.claude/settings.json` (or equivalent for Codex)

MVP implementation: `tools/team-knowledge/setup-knowledge.sh`

### 6. Shared Bundle Conventions

- YAML frontmatter types: `system`, `decision`, `runbook`, `concept`, `person`
- `index.md` structure
- PR template for promotions
- How to link: use relative Markdown links for OKF conformance; tolerate `[[concept-id]]` syntax for LLM-Wiki/Obsidian compatibility

MVP conventions: `docs/team-knowledge-system-conventions.md`

---

## What NOT to Build (Yet)

- A graph database — not needed for a team of engineers
- Custom ACL — git repo permissions handle it
- Slack/Teams bot — useful later, not required for the core model
- Semantic search / embeddings — start with full-text + metadata; add later if needed
- Mandatory documentation review for every captured item

---

## Key Research Findings (from verified deep-research, 2026-06-18)

1. **OKF is 6 days old** — adopt the *format* (plain markdown, trivially reversible), but don't bet on its ecosystem tooling yet.
2. **OKF does NOT define access control** — this is explicitly out of scope. Git permissions are the right layer.
3. **Both LLM-Wiki reference implementations are single-user** — the team/shared extension is genuinely new work.
4. **MCP-server-over-markdown is the de facto agent consumption path** — verified across multiple sources.
5. **Letta has shared memory blocks** (shared across agent sessions) if runtime shared memory (not just static docs) is needed later.
6. **Neo4j Enterprise has fine-grained node/property RBAC** — technically feasible for unified-with-partitions, but Enterprise Edition only, and "turnkey multi-tenancy" was refuted — still requires custom work. Save for v2 if needed.

---

## Open Questions (not yet resolved)

1. Which five repos are in scope first, and which labels/events already exist there?
2. What review SLA is acceptable for flagged items: daily, twice weekly, or only before release?
3. Should auto-captured context commit directly to the shared repo, or batch into a generated PR?
4. How should repeated agent questions be detected across tools?
5. Does the control surface live as a static local app, a GitHub Pages view, or inside an internal platform page?

---

## Sources

- Karpathy LLM-Wiki gist: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- OKF announcement: https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/
- OKF spec (GitHub): https://github.com/GoogleCloudPlatform/knowledge-catalog
- `nashsu/llm_wiki` (reference MCP implementation): https://github.com/nashsu/llm_wiki
- MarkTechPost OKF summary: https://www.marktechpost.com/2026/06/16/google-cloud-introduces-open-knowledge-format-okf-a-vendor-neutral-markdown-spec-for-giving-ai-agents-curated-context/
- Neo4j read privileges docs: https://neo4j.com/docs/operations-manual/current/authentication-authorization/privileges-reads/
