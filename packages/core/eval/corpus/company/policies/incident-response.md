---
type: policy
title: Incident response
description: Severity levels, paging expectations, and postmortem requirements.
tags: [oncall, incident, sev, postmortem]
updated: 2026-03-18
---

## Severity Levels {#severity}

Sev1 is customer-visible loss of a core flow. Sev2 is degraded service or a workaround-available failure. Sev3 is internal-only impact. Anything below that is a ticket, not an incident.

## Paging {#paging}

Sev1 pages the owning team immediately and the incident commander rota after ten minutes. Sev2 pages during business hours only. Nobody is paged for Sev3.

## Communication {#communication}

The incident channel is the single source of truth during an active incident. Status updates go out every thirty minutes for Sev1 until mitigation.

## Postmortems {#postmortem}

Every Sev1 and Sev2 gets a written, blameless postmortem within five business days. Action items are tracked to completion; a postmortem with no owner on an action item is not complete.
