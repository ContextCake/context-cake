---
type: policy
title: Data retention policy
description: How long each class of record may be kept before deletion.
tags: [compliance, retention, privacy]
updated: 2026-04-02
---

## Customer Records {#customer}

Customer account records are retained for seven years after account closure, then hard-deleted. Deletion is verified by the annual compliance audit.

## Event and Telemetry Data {#telemetry}

Raw event streams are retained for ninety days. Aggregated metrics derived from them may be kept indefinitely provided they carry no user identifier.

## Logs {#logs}

Application logs are retained for thirty days in hot storage and one year in cold storage. Logs must never contain personally identifiable information.

## Deletion Requests {#deletion}

A verified user deletion request must be honored across every system within thirty days, including warehouse copies and backups scheduled for expiry.
