---
type: standard
title: Code review expectations
description: What a reviewer is accountable for and how long review should take.
tags: [review, quality, process]
updated: 2026-01-22
---

## Required Approvals {#approvals}

Every change to a service repository needs one approving review from someone outside the change's authorship. Two approvals are required for changes to authentication, billing, or data deletion paths.

## Reviewer Responsibility {#responsibility}

A reviewer is accountable for correctness, test coverage, and whether the change matches the stated intent. A reviewer is not accountable for style; formatters handle that.

## Turnaround {#turnaround}

First response within one business day. A review request older than two business days may be escalated to the team lead.

## Automation {#automation}

Formatting, linting, and dependency policy are enforced by CI, not by humans in review comments.
