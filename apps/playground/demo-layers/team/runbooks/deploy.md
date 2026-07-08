---
type: runbook
title: Deploy
updated: 2026-06-18
owner: Data
tags: [deploy, ci]
---

# Deploy

## Trigger {#trigger}

Merges to `main` deploy to staging automatically. Production is a manual promote from
the pipeline UI after the staging smoke test is green.

## Rollback {#rollback}

Re-run the previous successful pipeline. Never hotfix straight to production — roll
back first, then fix forward on a branch.
