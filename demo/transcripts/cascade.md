# Captured transcript — cascade context (full 3-layer)

**Prompt:** Scaffold a new streaming job that reads our events topic and writes aggregates to the warehouse.

**Context source:** `demo/manifests/full.json` — Personal (L3) > Team (L2) > Company (L0) cascade

**Expected shape:** a Scala + Spark Structured Streaming scaffold (sbt) that fits the team's repo, applies the inherited company secrets/auth + security conventions, and notes the stale exemption.

---

**Tool call:** `read_file("decisions/service-stack")`

**Resolved context this agent sees (section-by-section composite):**
- **Language/Framework** ← Team (L2, 2026-05-15): Scala 2.13 + Spark Structured Streaming for pipelines; Java 17 for legacy; **do not use Spring Boot**
- **Secrets/Auth** ← Company (L0, inherited): company SSO + company vault; no service-local credential stores
- **Security** ← Company (L0, inherited): PII encrypted at rest and in transit; company data-retention policy applies
- **Enforcement** ← Company (L0, inherited): Spring Boot/Java 21 conformance check in company CI — **⚠ NOTE: team's Language override was recorded against an older Company base (hash drift detected); re-confirmation may be required**

---

I can see from the knowledge base that this team uses **Scala 2.13 + Spark Structured Streaming** for
pipeline workloads — not Spring Boot. The company Secrets and Security standards are inherited. Also
noting a stale-shadow alert: the team's language exemption was recorded before the company added the
`§Enforcement` section; you may want to re-confirm it.

Here's the scaffold:

**`build.sbt`**
```scala
ThisBuild / scalaVersion := "2.13.14"
ThisBuild / version      := "0.1.0-SNAPSHOT"
ThisBuild / organization := "com.company.data"

lazy val root = (project in file("."))
  .settings(
    name := "events-aggregator",
    libraryDependencies ++= Seq(
      "org.apache.spark" %% "spark-sql"              % "3.5.1" % "provided",
      "org.apache.spark" %% "spark-sql-kafka-0-10"   % "3.5.1",
      // company vault client — read secrets via SSO, no local credential stores
      "com.company.internal" % "vault-client" % "2.4.0"
    )
  )
```

**`src/main/scala/com/company/data/EventsAggregator.scala`**
```scala
package com.company.data

import org.apache.spark.sql.{DataFrame, SparkSession}
import org.apache.spark.sql.functions._
import org.apache.spark.sql.streaming.Trigger
import com.company.internal.vault.VaultClient

object EventsAggregator {

  def main(args: Array[String]): Unit = {
    val spark = SparkSession.builder()
      .appName("events-aggregator")
      .getOrCreate()

    import spark.implicits._

    // Secrets via company vault (inherited org standard — no local credential stores)
    val vault   = VaultClient.fromSSO()
    val brokers = vault.secret("kafka/bootstrap-servers")
    val warehouseUrl = vault.secret("warehouse/jdbc-url")

    val raw: DataFrame = spark.readStream
      .format("kafka")
      .option("kafka.bootstrap.servers", brokers)
      .option("subscribe", "events")
      .option("startingOffsets", "earliest")
      .load()

    val parsed = raw
      .selectExpr("CAST(key AS STRING) AS event_key", "CAST(value AS STRING) AS payload")
      .withColumn("event_ts", current_timestamp())

    // Tumbling 5-minute window aggregate
    val agg = parsed
      .groupBy(window($"event_ts", "5 minutes"), $"event_key")
      .agg(count("*").alias("event_count"))
      .select(
        $"window.start".alias("window_start"),
        $"window.end".alias("window_end"),
        $"event_key",
        $"event_count"
      )

    // Write to warehouse — PII fields must be encrypted per company security standard
    agg.writeStream
      .outputMode("append")
      .format("jdbc")
      .option("url", warehouseUrl)
      .option("dbtable", "events_aggregates")
      .option("checkpointLocation", "/checkpoints/events-aggregator")
      .trigger(Trigger.ProcessingTime("1 minute"))
      .start()
      .awaitTermination()
  }
}
```

**`src/main/resources/log4j2.properties`**
```properties
rootLogger.level = WARN
logger.spark.name = org.apache.spark
logger.spark.level = WARN
```

Key decisions made from the cascade context:
- **Scala 2.13 + Spark Structured Streaming** — team standard, not Spring Boot
- **Vault client via SSO** — company secrets/auth standard, inherited; no hardcoded credentials
- **PII encryption note** — company security compliance, inherited; encrypt any PII columns before writing
- **⚠ Stale exemption** — the team's Scala/Spark override predates the company's new `§Enforcement`
  section. The job should pass the conformance gate or the team should re-confirm the exemption.
