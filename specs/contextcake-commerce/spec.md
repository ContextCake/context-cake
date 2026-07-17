# ContextCake Commerce, Packs, and Creator Program

ContextCake stays fully useful as a local-first product while adding paid convenience,
team governance, and separately purchased expert Packs. Commerce must extend the open
local product without turning local resolution, authoring, or agent access into a trial.

**Date:** 2026-07-17
**Status:** Approved commercial foundation; billing remains disabled until the matching
product behavior is live
**Depends on:** `specs/contextcake-auth/spec.md`, `specs/contextcake-packs/spec.md`, and
`specs/contextcake-distribution/spec.md`

## Problem Statement

ContextCake has a local engine, a desktop application, optional account sync, and a first
Pack contract, but no durable explanation of what remains free, what a subscription buys,
or how outside experts can sell inspectable professional context. Without that boundary,
pricing risks weakening the local-first promise, Packs risk becoming a prompt store, and
marketplace language risks getting ahead of the trust and payout systems needed to support
third-party creators.

The commercial product therefore separates three things:

1. the ContextCake application plan;
2. a perpetual Pack license; and
3. optional access to future editorial Pack updates.

## User Stories

- As a **local user**, I can resolve, author, import, export, and serve my own context
  without an account, limit, or paid prompt.
- As an **individual professional**, I can pay for cross-device continuity and managed
  Pack maintenance without moving my context content into a hosted knowledge silo.
- As a **small-team administrator**, I can control Pack entitlements and update rollout
  while the underlying context and credentials remain on each member's machine.
- As a **Pack buyer**, I can inspect who made a Pack, what it contains, what it can access,
  and how recently it was reviewed before I install it.
- As a **Pack creator**, I can package professional material I own, choose a reviewed price
  band, and receive a clear revenue share without buying a ContextCake subscription.

## Pricing and Entitlements

### Application plans

- **Free — $0 forever.** Unlimited local sources, layers, profiles, resolution, MCP access,
  Pack authoring, manual import/export, catalog browsing, and installation of free or
  purchased Packs. No account is required for local work.
- **Pro — $9/month or $90/year.** Free plus cross-device settings, profile, and entitlement
  sync; managed Pack update review with diff and rollback; linked deployment across
  supported local AI tools; 90-day version history; and priority support.
- **Team — $29/month or $290/year.** Includes three seats, with additional seats at
  $7/month. Adds centralized billing, an approved Pack catalog, Pack assignment,
  staged or pinned updates, organization roles, and administrative history.

Paid application plans and checkout SHALL remain labeled **Coming soon** until every listed
capability for that plan is available in the production application. There is no Enterprise
plan until SSO, deployment controls, and an enterprise support model exist.

### Pack licenses

- Packs may be free or use one of four reviewed personal/team price pairs:
  `$19/$49`, `$49/$129`, `$99/$249`, or `$149/$399`.
- The Data & Analytics Pack uses the `$99 personal / $249 team` band.
- A team Pack license covers up to five named users in one organization.
- A Pack purchase is perpetual for every version already delivered.
- Safety, broken-link, and compatibility corrections remain available to base purchasers.
- New modules and recurring editorial releases may require an optional update subscription.
- Suggested personal update prices are `$5`, `$9`, or `$19` per month; the team price is
  reviewed alongside the base license.
- Canceling an update subscription stops future delivery but never disables retained files.
- Buying or installing a Pack never requires a Pro or Team application subscription.

### Creator economics

- The first 20 approved creators receive 90% of product revenue for their first 12 months,
  excluding taxes, refunds, and chargebacks. ContextCake pays processing costs from its
  share. The creator share becomes 80% after that period.
- Publishing never requires a paid application plan.
- The curated pilot uses the existing merchant-of-record checkout and manual royalty
  statements. Automated marketplace payouts are out of scope until legal, tax, refund,
  dispute, and merchant-liability responsibilities are reviewed.

## Pack Trust Contract

Published Packs SHALL declare creator identity, license model, supported surfaces, update
policy, source and rights disclosures, freshness, requested permissions, compatibility,
review status, and release-artifact checksum metadata in `PACK.yaml`.

The curated catalog initially accepts content-only Packs: inspectable Markdown/OKF,
metadata, templates, examples, and optional declarative skill instructions. A Pack SHALL
NOT contain executable scripts, bundled MCP servers, hidden network calls, credential
requirements, or symlinks that escape the Pack root.

Creators SHALL attest that they own or can commercially distribute every included item.
Employer materials, client information, student data, and copied commercial training
content are prohibited without documented rights. Professional workflow Packs are allowed;
substantive legal, medical, and financial advice remains out of scope until credential,
jurisdiction, citation, freshness, and expert-review policies exist.

## Acceptance Criteria

### Free and paid boundaries

- [ ] WHEN a user is signed out THE SYSTEM SHALL provide every existing local resolution,
  authoring, source, profile, and MCP workflow without a count limit or paid prompt.
- [ ] WHEN a Free user obtains a free or paid Pack THE SYSTEM SHALL allow that user to
  inspect, install, use, manually update, remove from a profile, and retain the Pack.
- [ ] WHEN a subscription is canceled THE SYSTEM SHALL NOT disable local context or Pack
  versions already delivered.
- [ ] WHEN a paid application tier is marketed as available THE SYSTEM SHALL provide every
  capability listed for that tier in the production application.

### Installation and privacy

- [ ] WHEN a Pack is inspected THE SYSTEM SHALL show its creator, license, intended
  workflow, supported tools, freshness, update policy, permissions, samples, and changelog.
- [ ] WHEN a Pack is installed THE SYSTEM SHALL validate its manifest and checksum, reject
  prohibited executable content or escaping symlinks, and add it as an explicit base layer.
- [ ] WHEN a Pack is updated or removed THE SYSTEM SHALL preserve every user-owned local
  overlay and keep the previous installed version available for rollback.
- [ ] WHEN account or organization metadata syncs THE SYSTEM SHALL exclude context content,
  local overlays, credentials, executable integration details, and absolute paths.

### Catalog and creators

- [ ] WHEN a creator listing is submitted THE SYSTEM SHALL block publication until rights
  attestation, manifest validation, content review, samples, freshness, and changelog checks
  pass.
- [ ] WHEN the catalog has fewer than 10 third-party Packs THE SITE SHALL call it
  **ContextCake Packs**, not claim a broad open marketplace.
- [ ] WHEN self-service creator submission or automated payouts are enabled THE PROGRAM
  SHALL first have at least 10 third-party Packs, 100 completed purchases, a refund rate
  below 5%, and a repeatable seven-day review process.

### Marketing comprehension

- [ ] WHEN a visitor reads the pricing page THE SITE SHALL state that local ContextCake is
  free, Packs are separate purchases, Pro is not required to install a Pack, and paid plans
  are unavailable until their functionality ships.
- [ ] WHEN five representative users test the pricing page ALL FIVE SHALL identify what
  remains free, and at least four SHALL correctly distinguish an application subscription,
  a Pack license, and an update subscription.

## Out of Scope

- Turning on checkout before production entitlements and advertised plan behavior exist.
- Open self-service creator uploads, automated creator payouts, ratings without verified
  purchases, or a public marketplace claim before the catalog gates are met.
- Hosted storage of customer context, local overlays, credentials, or remote-activatable
  integration commands.
- Executable or bundled-MCP Packs during the curated launch.
- Enterprise pricing, SSO, or custom deployment controls.

## Open Questions

None for the commercial foundation. High-stakes advisory content remains deferred by
default and requires a separately approved trust-policy amendment.

## Dependencies

- Optional GitHub OAuth and safe settings sync from the accounts specification.
- The standard Pack directory contract and local-overlay model from the Packs specification.
- A signed desktop distribution before managed install and update behavior can be sold.
- Merchant-of-record checkout for first-party and curated-pilot products.
- Legal and tax review before ContextCake becomes an automated multi-vendor marketplace.
