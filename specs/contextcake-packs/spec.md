# ContextCake Packs v1

ContextCake Packs are separately sold, profession-specific context kits: portable OKF markdown
bundles plus lightweight tool guidance that help small teams reuse the same domain knowledge,
workflow patterns, templates, and examples across Claude, ChatGPT, Cursor, Copilot, and future
ContextCake-powered surfaces.

**Date:** 2026-07-06
**Status:** Approved foundation - ready for private-pack repo implementation
**Workflow:** Requirements-first
**Primary target:** small in-house data and analytics teams
**Depends on:** `specs/contextcake-core/design.md` and `specs/contextcake-site/`

---

## 1. Problem Statement

Small teams are starting to use multiple AI tools for recurring professional work, but each tool
starts with the same blank-context problem. A data team may explain source-of-truth rules, metric
definitions, report validation habits, stakeholder clarification patterns, and insight-summary
style over and over again. That knowledge is not a generic prompt library; it is a reusable operating
context.

ContextCake Packs make that context portable. A pack is a plain-file bundle a team can inspect,
edit, zip, upload, install as a Claude Code plugin, or later point at a ContextCake layer. The first
pack proves the product shape without building a portal, checkout backend, updater, or autonomous
sync system before the market signal exists.

## 2. Goals

- Ship a first paid-content product line under the parent ContextCake brand without placing paid
  content in the public-bound engine repo.
- Prove that a profession-specific context kit improves one real workflow enough that users would
  pay for the base pack and value recurring curated updates.
- Keep the v1 distribution boring: plain zip files first, Claude Code plugin packaging second,
  manual fulfillment, and editorial updates.
- Preserve the ContextCake thesis: shipped base context plus local customer overlay, with updates
  applied visibly rather than silently overwriting local edits.
- Keep every pack authored as valid OKF markdown where appropriate, so future ContextCake layer
  integration is a compatibility path, not a rewrite.

## 3. Non-Goals

- No SaaS account system, hosted dashboard, self-update daemon, webhook fulfillment, or customer
  portal in v1.
- No bundled MCP server in a pack.
- No autonomous web-monitoring updater. Updates are curated editorial releases.
- No live data feed. The Data & Analytics pack must not become a metric catalog service, BI
  connector, or warehouse scanner.
- No paid pack content in this public-bound `context-cake` repo.
- No generic prompt-library positioning.

## 4. First Pack

**Pack:** ContextCake Pack: Data & Analytics Teams

**Audience:** small in-house data/analytics teams, including report builders, SQL analysts,
analytics engineers, PM-adjacent analysts, CS operations partners, and technical managers.

**Reason this ships first:** founder/beta access. This is the first candidate the founder can test
with real colleagues through the full checkout and fulfillment flow. Grant Teams, GovCon/RFP, HR,
and Insurance remain future candidates until there is real design-partner access.

**Hero workflow:**

1. Stakeholder request arrives.
2. Team clarifies scope, source of truth, metric definitions, and acceptance criteria.
3. Team builds and validates the answer against the source of truth.
4. Team delivers an insight summary with caveats, confidence, and next action.

## 5. Pack Contract

Every pack SHALL use the same logical customer-facing shape:

```text
START-HERE.md
PACK.yaml
overview/
glossary/
workflows/
templates/
examples/
prompt-guides/
policies-and-rules/
tool-guides/
local-overlay/
updates/CHANGELOG.md
updates/MERGE-GUIDE.md
```

The private repository implementation MAY nest that contract under a Claude Code skill directory.
The plain zip SHALL contain a single top-level folder named for the pack (for example
`data-analytics-team-pack/`); that delivered pack root SHALL expose the contract files and
directories listed above. The zip filename carries the pack version (for example
`data-analytics-team-pack-v0.1.0.zip`). This is the standard customer-friendly archive convention:
unzipping yields one clearly named folder rather than loose files.

Customer-facing content markdown SHALL be valid OKF unless explicitly excluded:

- frontmatter contains non-empty `type` and `updated`;
- body content is organized into headed sections;
- every heading has an explicit anchor such as `## Validate the Build {#validate-build}`.

Excluded from OKF validation:

- `START-HERE.md`
- `SKILL.md`
- `local-overlay/README.md`
- `updates/CHANGELOG.md`
- `updates/MERGE-GUIDE.md`

`PACK.yaml` is metadata, not markdown.

## 6. Private Repo Shape

Paid content and Claude Code plugin packaging live in a new private repo named
`contextcake-packs`.

The public engine repo carries a reviewable template at
`specs/contextcake-packs/private-repo-template/`. The private repo is created from that template and
then receives the real paid content.

Canonical private repo shape:

```text
contextcake-packs/
├── .claude-plugin/marketplace.json
├── packs/data-analytics-team/
│   ├── .claude-plugin/plugin.json
│   └── skills/data-analytics-team-pack/
│       ├── SKILL.md
│       ├── START-HERE.md
│       ├── PACK.yaml
│       ├── overview/
│       ├── glossary/
│       ├── workflows/
│       ├── templates/
│       ├── examples/
│       ├── prompt-guides/
│       ├── policies-and-rules/
│       ├── tool-guides/
│       ├── local-overlay/README.md
│       └── updates/
│           ├── CHANGELOG.md
│           └── MERGE-GUIDE.md
├── scripts/
│   ├── validate-okf.mjs
│   ├── validate-test.sh
│   └── build-plain-zip.mjs
└── RUNBOOK.md
```

The authored content root is `packs/data-analytics-team/skills/data-analytics-team-pack/`.
That keeps the pack usable as a Claude Code skill while remaining the same source tree used for the
plain zip.

## 7. Distribution

- Plain zip is the baseline channel. It must work without ContextCake, Claude Code, or a terminal.
- Claude Code plugin packaging is first-class for this first pack.
- Future ContextCake integration can point `layers.json` at an unzipped pack, but that is not a v1
  requirement.
- Base pack and updates are separate Stripe products.
- Fulfillment is manual in v1 through Stripe order notices and the private repo/release assets.

## 8. Acceptance Criteria

### Public site

- [ ] WHEN a buyer visits `/packs/data-analytics-teams` THE SYSTEM SHALL explain the offer without
  requiring OKF, MCP, resolver, or plugin vocabulary.
- [ ] WHEN the page presents pricing THE SYSTEM SHALL distinguish the one-time base pack from the
  optional monthly update subscription.
- [ ] WHEN the page describes compatibility THE SYSTEM SHALL state that plain files are the baseline
  and tool-specific packaging is additive.
- [ ] WHEN `cd site && npm run build` runs THE SYSTEM SHALL exit 0 with no broken internal links.

### Private pack repo template

- [ ] WHEN the private repo is created from the template THE REPO SHALL contain the standard Claude
  Code plugin shape: `.claude-plugin/plugin.json` plus `skills/<skill-name>/SKILL.md`.
- [ ] WHEN `scripts/validate-okf.mjs` runs THE SCRIPT SHALL reject missing `type`, missing `updated`,
  and headings without explicit anchors in OKF content files.
- [ ] WHEN `scripts/validate-test.sh` runs THE SCRIPT SHALL prove valid, invalid, excluded-file, and
  version-mismatch cases.
- [ ] WHEN `scripts/build-plain-zip.mjs` runs THE SCRIPT SHALL package only an explicit allowlist of
  pack-contract files and directories.

### Pilot

- [ ] WHEN a colleague receives beta access THE SYSTEM SHALL route them through the same checkout and
  fulfillment flow a paying customer uses.
- [ ] WHEN the pilot is scored THE PRODUCT SHALL proceed only if at least 4/5 users report a real
  workflow improvement and at least 3/5 say they would personally pay.

## 9. Boundaries

- ✅ **Always:** keep paid content out of the public engine repo; keep the plain-file channel viable;
  keep pack content inspectable and editable; validate OKF structure before packaging.
- ✅ **Always:** use manual/editorial fulfillment until the pilot gate is met.
- ⚠️ **Ask first:** before adding automation, webhooks, customer accounts, live data feeds, or a pack
  runtime dependency.
- 🚫 **Never:** silently overwrite customer local overlays; ship a pack zip by denylist; imply the
  update subscription is required to use the base pack; commit customer data, workplace examples, or
  proprietary real metrics.

## 10. For the Implementing Agent

1. Start site work from `origin/main`, where `site/` and `specs/contextcake-distribution/` exist.
2. Keep implementation branches/worktrees clean; the root checkout may contain unrelated local work.
3. Build the public spec and landing page in `context-cake`.
4. Use `specs/contextcake-packs/private-repo-template/` only as a scaffold handoff for the future
   private repo. Do not add real paid pack content here.
5. Run `cd site && npm run build` before presenting the preview.
6. Before opening a PR, compare implementation against this spec and list unmet acceptance criteria.
