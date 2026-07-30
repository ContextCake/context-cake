---
type: policy
title: Security baseline
description: Minimum security controls every service must meet before it serves traffic.
tags: [security, secrets, encryption, compliance]
updated: 2026-06-10
---

## Secrets Handling {#secrets}

Services read secrets from the company vault at startup. No credential may be committed to a repository, baked into an image, or passed as a plaintext environment variable in a deployment manifest.

## Encryption {#encryption}

Personally identifiable information is encrypted at rest and in transit. TLS 1.3 is required for all internal and external traffic; TLS 1.2 is permitted only for third-party endpoints that cannot negotiate 1.3.

## Authentication {#authentication}

Service-to-service calls authenticate through company SSO with short-lived tokens. Long-lived API keys are prohibited except for vendor integrations that offer no alternative, and those must be rotated quarterly.

## Dependency Hygiene {#dependencies}

Automated dependency updates are mandatory. A critical advisory must be patched within seven days; a high advisory within thirty.
