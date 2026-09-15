# dbt artifacts as a generated context layer

Status: exploration only. No importer or warehouse access ships in this increment.
Assessment date: 2026-09-14.

## First slice

Import a user-selected local `manifest.json` into a generated OKF layer: active
models and sources, descriptions, declared columns, and immediate dependencies.
Do not execute dbt, connect to a warehouse, ingest SQL, or infer column lineage.
The useful demonstration is a model definition with separately authored team
guidance, carrying both origins through a normal ContextCake resolve.

## Artifact availability and schema policy

| Artifact | Availability | Proposed use |
| --- | --- | --- |
| `manifest.json` | Project parsing writes an artifact under `target/`; hosted job runs expose downloadable artifacts | First import: logical definitions and dependency edges |
| `catalog.json` | Warehouse-derived relation/column metadata, produced by catalog generation; command details vary by dbt version | Later optional enrichment, never a prerequisite |
| `run_results.json` | Results from executed resources, not evidence that every model ran | Later dated execution observations |
| `sources.json` | Source-freshness command output | Later freshness observations, distinct from description dates |

Dispatch by `metadata.dbt_schema_version`, not the dbt release number or filename.
Recommend **manifest v12 only** for the initial importer, with a checked-in minimal
fixture and explicit rejection of other schema URLs. The published schema index
currently lists v12; older manifest v11/v10 and catalog v1/run-results v6 would need
separate adapters and fixture tests before being called supported. No versions are
supported by ContextCake today. [Manifest documentation](https://docs.getdbt.com/reference/artifacts/manifest-json),
[schema registry](https://schemas.getdbt.com/), [catalog documentation](https://docs.getdbt.com/reference/artifacts/catalog-json),
[run-results documentation](https://docs.getdbt.com/reference/artifacts/run-results-json).

## Identity, dependencies, and dates

- Preserve the complete `unique_id` from the artifact, including versioned model
  identity. Namespace it with a user-selected project identity so independent
  projects cannot collide. Do not identify models by warehouse alias, display
  name, local path, or a split that discards trailing identity components.
- Renames can change `unique_id`. Treat removal/addition as explicit changes;
  offer an intentional mapping later instead of silently moving annotations.
- Map `depends_on.nodes` to concept links, cross-checking `parent_map` where
  available. Keep only supported node types in the first import. Report omitted
  or unresolved edges; never invent missing nodes or imply column lineage.
- `metadata.generated_at` means artifact observation time. It is not the date a
  human last edited a description, nor proof a model successfully ran. Keep it as
  provenance metadata. Use an authored content date only if separately verified;
  otherwise leave the content date unknown. Execution and freshness timestamps
  belong in distinct observation sections.

## Minimal illustrative mapping

```text
project: analytics
unique_id: model.shop.orders
description: One row per order
depends_on.nodes: [source.shop.raw.orders]

concept: dbt/analytics/model.shop.orders
section dbt-definition: One row per order
section dbt-dependencies: [[dbt/analytics/source.shop.raw.orders]]
metadata: artifact schema URL, generated_at, artifact digest, original unique_id
```

Generated content is replaced only inside the importer's owned layer. Team notes
use the same concept ID in a separate human-owned layer, with keys such as
`operating-guidance`. Re-import must preserve that layer byte-for-byte. Provenance
distinguishes generated metadata from a human override; precedence is not factual
confidence. Artifact removals need an explicit diff and tombstone policy before
automatic deletion is allowed.

Before implementation: bound artifact bytes/nodes/edges, reject malformed schema
and duplicate identities, sanitize generated filenames, and test versioned models,
missing dependencies, stale observations, idempotent re-import, removal, and human
annotation preservation. Catalog/SQL/warehouse integration stays out of this slice.
