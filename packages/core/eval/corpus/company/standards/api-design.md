---
type: standard
title: API design conventions
description: Naming, versioning, and error conventions for HTTP services.
tags: [api, http, rest, versioning]
updated: 2026-03-01
---

## Resource Naming {#naming}

Paths are plural nouns in kebab-case. Verbs belong in the HTTP method, not the path.

## Versioning {#versioning}

Breaking changes ship behind a new major version in the path. A major version is supported for twelve months after its successor is generally available.

## Errors {#errors}

Errors return a machine-readable code alongside a human-readable message. Never return a 200 with an error body.

## Pagination {#pagination}

Collection endpoints paginate by opaque cursor. Offset pagination is not permitted on datasets that can change under the reader.
