---
type: runbook
title: Standard deployment process
description: How a change gets from a merged pull request to production.
tags: [deploy, ci, release, rollback]
updated: 2026-05-05
---

## Pipeline {#pipeline}

A merge to the default branch builds an image, runs the full test suite, and deploys to staging automatically. Production is a manual promotion from a green staging build.

## Promotion Gates {#gates}

Promotion requires a green staging run, no open Sev1, and an approver who is not the change author.

## Rollback {#rollback}

Roll back by promoting the previous known-good image tag. Do not roll forward with a hotfix during an active incident unless the previous image is also broken.

## Deployment Windows {#windows}

Deploys are allowed any weekday before 16:00 local time for the owning team. Friday afternoon and holiday-eve deploys require an explicit exception.
