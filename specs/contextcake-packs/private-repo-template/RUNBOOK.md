# Fulfillment Runbook

Lemon Squeezy is the **merchant of record**. It runs checkout, receipts, refunds, and
sales-tax/VAT, and it **auto-delivers the plain-files pack** (download + license key) on
purchase. This runbook covers only what is still manual in v1: the Claude Code plugin
channel, update publishing, and feedback.

## Trigger

A Lemon Squeezy order completes for the base pack, the updates subscription, or a pilot
checkout using a 100%-off discount code. Lemon Squeezy emails you the order and emails the
customer their download + license key automatically.

## What Lemon Squeezy handles automatically

- Checkout, payment, receipt, and refund flow.
- Sales tax / VAT collection and remittance (merchant of record — not your filing burden).
- Plain-files delivery: the customer receives the versioned pack zip and a license key by
  email immediately, with no action from you.

## Manual steps (v1)

1. Record the order in the tracking table: customer email, product (base / updates), amount,
   discount code, and timestamp.
2. Claude Code plugin channel (only if the customer wants it): invite their GitHub account
   as a **read-only** collaborator on `contextcake-packs`, then send marketplace/install
   instructions. Never grant write, maintain, or admin.
3. Sanity-check that the Lemon Squeezy download resolves to the current `dist/` zip version.
4. Updates: when `updates/CHANGELOG.md` gets a new release entry, publish the new version —
   update the product file in Lemon Squeezy and notify update subscribers (email the new zip
   or point them to the refreshed download). Keep plugin-channel repo access alive for them.
5. Send feedback separately 1-2 weeks after real use. Ask: "Would you personally have paid
   $X out of pocket for this?" ($99 base / $9-mo updates.)

## Release checklist (per version)

1. Bump `PACK.yaml` and `plugin.json` to the same version.
2. `node scripts/validate-okf.mjs` and `bash scripts/validate-test.sh` pass.
3. `node scripts/build-plain-zip.mjs` → the versioned zip plus its archive `.sha256` sidecar;
   confirm the staged Pack content checksum and archive checksum are both printed.
4. Upload that zip as the base-pack (and updates) product file in Lemon Squeezy.
5. Tag/release the same zip in this private GitHub repo as the internal source of truth.

## Tracking Table

| Customer | Product | Version | Plugin channel? | Paid/Test | Fulfilled | Feedback |
|---|---|---:|---|---|---|---|
|  |  |  |  |  |  |  |

## Future automation (post-pilot)

Wire a Lemon Squeezy webhook (`order_created`) to auto-invite GitHub collaborators and log
orders, removing the manual plugin-channel step.
