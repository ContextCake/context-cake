---
title: ContextCake and data catalogs
description: How sourced project context relates to catalogs of data assets.
---

ContextCake serves written project context to AI tools: decisions, instructions,
runbooks, and notes, with sources and disagreements attached. Data catalogs focus
on discovering and understanding data assets. These can be complementary parts of
an engineering workflow.

## What ContextCake does today

- Reads configured Markdown folders, OKF bundles, GitHub sources, and foreign MCP
  sources that implement ContextCake's graph contract.
- Resolves matching sections across layers and preserves dissenting values.
- Shows source health and coverage; measures retrieval in native diagnostics.
- Applies recorded source policies only while their evidence and scope remain valid.

Source precedence is a configured selection rule. It is **not a confidence score,
a claim of factual correctness, or an authorization policy**. The permissions of
the underlying folders, repositories, and processes still matter.

## Authoritative files and local copies

Source files remain authoritative. ContextCake maintains derived indexes, may
cache source responses on disk, and can clone repositories for desktop sources.
Its file editor and explicit resolution actions can change configured source
files; recorded source policies preserve the original documents.

This is different from promising that no content is copied. Removing a source
from the active cascade is also different from revoking access to a repository.
Read [the trust boundary](/docs/concepts/trust-boundary).

## Integration requires an adapter

A system having an MCP server does not make it a compatible ContextCake source.
The current foreign-source adapter requires `list_nodes` and `get_node` with the
specified shapes. Connecting a catalog such as OpenMetadata would require a
verified translation into that contract. **No production catalog connector ships
with ContextCake today.** See [foreign MCP sources](/docs/guides/foreign-mcp-sources).

A small dbt artifact import is under assessment. It would bring model descriptions
and dependencies into a generated layer while keeping human annotations separate.
There is no dbt importer, warehouse connection, column-level lineage service, or
new graph database in the current increment.

For catalog capabilities and deployment requirements, consult the catalog's own
current documentation. ContextCake does not replace data governance, warehouse
permissions, data quality execution, or an organization's catalog.
