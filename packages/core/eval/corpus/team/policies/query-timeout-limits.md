---
type: policy
title: Query timeout limits
description: Timeout values enforced on ad hoc and API queries against the warehouse.
tags: [timeout, query]
updated: 2026-05-02
---

## API Query Timeout {#api}

A query issued from a service's API path is killed after 30 seconds so a single slow endpoint cannot hold a connection open indefinitely.

## Ad Hoc Console Queries {#console}

A query run from the internal SQL console is killed after 5 minutes. Anything slower belongs in a scheduled batch job, not an interactive session.
