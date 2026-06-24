# Captured transcript — company-only context

**Prompt:** Scaffold a new streaming job that reads our events topic and writes aggregates to the warehouse.

**Context source:** `demo/manifests/company-only.json` — company layer only (no team override)

**Expected shape:** a Spring Boot / Java 21 scaffold (`@SpringBootApplication`, Maven `pom.xml`, `@KafkaListener`) — the wrong stack for this team.

---

**Tool call:** `read_file("decisions/service-stack")`

**Resolved context this agent sees:**
- **Language/Framework:** Spring Boot with Java 21 — the standard for all new services org-wide
- **Secrets/Auth:** company SSO + company vault; no service-local credential stores
- **Security:** PII encrypted at rest and in transit; company data-retention policy applies
- **Enforcement:** must pass Spring Boot / Java 21 conformance check in company CI

---

Based on our service stack standard (Spring Boot / Java 21), here's the streaming aggregation job scaffold:

**`pom.xml`**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.0</version>
  </parent>
  <groupId>com.company</groupId>
  <artifactId>events-aggregator</artifactId>
  <version>0.1.0-SNAPSHOT</version>
  <properties><java.version>21</java.version></properties>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.kafka</groupId>
      <artifactId>spring-kafka</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-data-jpa</artifactId>
    </dependency>
  </dependencies>
</project>
```

**`EventsAggregatorApplication.java`**
```java
package com.company.aggregator;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class EventsAggregatorApplication {
    public static void main(String[] args) {
        SpringApplication.run(EventsAggregatorApplication.class, args);
    }
}
```

**`EventsConsumer.java`**
```java
package com.company.aggregator;

import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class EventsConsumer {

    private final AggregateRepository repository;

    public EventsConsumer(AggregateRepository repository) {
        this.repository = repository;
    }

    @KafkaListener(topics = "${kafka.topic.events}", groupId = "${kafka.group-id}")
    public void consume(ConsumerRecord<String, String> record) {
        // deserialize, aggregate, upsert to warehouse
        repository.upsertAggregate(record.key(), record.value());
    }
}
```

**`application.yml`**
```yaml
spring:
  kafka:
    bootstrap-servers: ${KAFKA_BOOTSTRAP_SERVERS}
    consumer:
      group-id: events-aggregator
      auto-offset-reset: earliest
      key-deserializer: org.apache.kafka.common.serialization.StringDeserializer
      value-deserializer: org.apache.kafka.common.serialization.StringDeserializer
kafka:
  topic:
    events: events
```

This follows the org standard: Spring Boot 3 / Java 21. Wire `KAFKA_BOOTSTRAP_SERVERS` and your
warehouse datasource via environment variables, then implement `AggregateRepository` against your
target store.
