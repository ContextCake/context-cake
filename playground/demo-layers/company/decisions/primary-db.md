---
type: decision
title: Primary database
updated: 2026-05-01
owner: Platform
tags: [database, architecture]
---

# Primary database

## Choice {#choice}

Postgres (org standard). All services provision managed RDS through the platform
catalog. No other primary datastore is approved for production.

## Rationale {#rationale}

One vendor, one backup story, one compliance boundary. Managed RDS is SOC2-covered
and the security team already audits it.

## Ownership {#ownership}

Platform team owns provisioning, upgrades, and the backup policy. File a ticket in
`platform/infra` for a new instance.

## Related {#related}

See [[incident-response]] for the on-call path when a database is degraded.
