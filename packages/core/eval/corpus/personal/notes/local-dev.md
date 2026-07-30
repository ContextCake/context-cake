---
type: note
title: Local development setup
description: Getting a pipeline running on a laptop without a cluster.
tags: [local, development, docker, sbt]
updated: 2026-07-12
---

## Running Locally {#running}

`docker compose up` in the platform repo brings up Kafka, the schema registry, and a single-node Postgres. Spark runs in local mode against those; there is no local ClickHouse, so analytics assertions have to be stubbed.

## Common Snag {#snag}

The compose file binds Kafka on the host network, so the advertised listener has to be `localhost:9092` or the driver connects to the broker and then fails on the second hop with a name it cannot resolve. This costs everyone an afternoon exactly once.

## Speeding Up Iteration {#iteration}

Keep an sbt shell open and use `~testQuick`. A cold sbt start is slower than the test run it is about to do.
