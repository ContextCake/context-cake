---
type: decision
title: Service stack standard
description: What the data platform team actually runs, and why it differs from the org default.
tags: [platform, language, scala, spark]
updated: 2026-06-18
---

## Language and Framework {#language}

Scala 2.13 with Spark Structured Streaming for pipelines, and Java 17 for the remaining legacy request/response services. We do not use Spring Boot: our workloads are streaming and batch, not request/response, and the Spring lifecycle fights the Spark driver model.

## Build and Packaging {#build}

sbt with the assembly plugin, because the shared Gradle convention plugin has no Scala cross-build support. Images are still published to the internal registry.
