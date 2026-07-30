---
type: decision
title: Schema evolution rules
description: Which Avro schema changes are allowed without breaking downstream consumers.
tags: [avro, schema, compatibility]
updated: 2026-05-29
---

## Compatibility Mode {#compatibility}

The registry enforces backward compatibility. A new schema must be readable by consumers still on the previous version.

## Allowed Changes {#allowed}

Adding a field with a default is allowed. Widening a numeric type is allowed. Adding a new enum symbol is allowed only if consumers use a default branch.

## Forbidden Changes {#forbidden}

Removing a field, renaming a field, and narrowing a type all break readers and are rejected at registration. Renaming is the one people try most often; ship an additive field and deprecate the old one instead.
