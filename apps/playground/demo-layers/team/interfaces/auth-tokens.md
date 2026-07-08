---
type: interface
title: Auth tokens
updated: 2026-06-15
owner: Identity
tags: [auth, contract, scopes]
---

# Auth tokens

## Scopes {#scopes}

Our services read the `scope` claim (space-delimited). `reports:read` is required for
the analytics endpoints. Absent scope means deny, not allow.
