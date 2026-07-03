---
type: interface
title: Auth tokens
updated: 2026-04-02
owner: Identity
tags: [auth, contract]
---

# Auth tokens

## Format {#format}

JWT, RS256, 15-minute expiry. The `aud` claim must name the calling service. Tokens
are minted only by the identity service.

## Rotation {#rotation}

Signing keys rotate every 90 days. Consumers must fetch the JWKS on a 5-minute cache.
