---
type: decision
title: Service stack standard
description: The org-wide default language, framework, and runtime for new services.
tags: [platform, language, standard]
updated: 2026-06-01
---

## Language and Framework {#language}

Spring Boot with Java 21. This is the standard for all new services org-wide. Teams that need a different runtime must file an exemption with the platform group and re-confirm it annually.

## Build and Packaging {#build}

Gradle with the shared convention plugin. Services publish an OCI image to the internal registry; no team maintains its own base image.

## Runtime Targets {#runtime}

Services run on the shared Kubernetes platform. Bare EC2 and per-team clusters were retired in 2025.

## Enforcement {#enforcement}

New services must pass the Java 21 conformance check in company CI. Existing exemptions expire twelve months after they are granted.
