---
title: ContextCake and OpenMetadata
description: OpenMetadata catalogs your data. ContextCake resolves your written rules. Here is where they differ and how they fit together.
---

OpenMetadata calls itself a context layer. So do we. The words match. The job does not.

**OpenMetadata is a data catalog.** It crawls your warehouses, dashboards, and pipelines,
then records what each table holds, who owns it, and what feeds it.

**ContextCake is a context resolver.** It reads the rules your team has written down —
decisions, standards, runbooks, personal notes — and works out which one applies right now.

Both hand their answer to an AI tool over MCP. They are answering different questions.

<figure class="cc-cmp-figure">
<svg viewBox="0 0 800 260" role="img" aria-labelledby="cc-fig1-title">
<title id="cc-fig1-title">OpenMetadata indexes data assets and answers questions about tables. ContextCake indexes written rules and answers questions about which rule applies.</title>
<defs><marker id="cc-a1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--sl-color-gray-4)" /></marker></defs>
<line x1="400" y1="14" x2="400" y2="246" stroke="var(--sl-color-hairline)" stroke-width="1" />
<text x="20" y="28" font-size="18" font-weight="700" fill="var(--sl-color-text)">OpenMetadata indexes data assets</text>
<g font-size="17" fill="var(--sl-color-text)" text-anchor="middle">
<rect x="20" y="48" width="110" height="32" rx="8" fill="none" stroke="var(--sl-color-gray-4)" /><text x="75" y="69">Tables</text>
<rect x="135" y="48" width="110" height="32" rx="8" fill="none" stroke="var(--sl-color-gray-4)" /><text x="190" y="69">Dashboards</text>
<rect x="250" y="48" width="110" height="32" rx="8" fill="none" stroke="var(--sl-color-gray-4)" /><text x="305" y="69">Pipelines</text>
</g>
<path d="M190 84 L190 108" stroke="var(--sl-color-gray-4)" stroke-width="1.5" marker-end="url(#cc-a1)" />
<rect x="20" y="114" width="340" height="46" rx="10" fill="var(--cc-layer-company)" />
<text x="190" y="143" font-size="18" font-weight="600" fill="#151917" text-anchor="middle">Catalog of your data</text>
<text x="190" y="202" font-size="19" font-style="italic" fill="var(--sl-color-text)" text-anchor="middle">“Which table has revenue in it,</text>
<text x="190" y="225" font-size="19" font-style="italic" fill="var(--sl-color-text)" text-anchor="middle">and who owns it?”</text>
<text x="440" y="28" font-size="18" font-weight="700" fill="var(--sl-color-text)">ContextCake indexes written rules</text>
<g font-size="17" fill="#151917" text-anchor="middle">
<rect x="440" y="48" width="110" height="32" rx="8" fill="var(--cc-layer-company)" /><text x="495" y="69">Company</text>
<rect x="555" y="48" width="110" height="32" rx="8" fill="var(--cc-layer-team)" /><text x="610" y="69">Team</text>
<rect x="670" y="48" width="110" height="32" rx="8" fill="var(--cc-layer-personal)" /><text x="725" y="69">You</text>
</g>
<path d="M610 84 L610 108" stroke="var(--sl-color-gray-4)" stroke-width="1.5" marker-end="url(#cc-a1)" />
<rect x="440" y="114" width="340" height="46" rx="10" fill="var(--cc-layer-team)" />
<text x="610" y="143" font-size="18" font-weight="600" fill="#151917" text-anchor="middle">One answer, with its sources</text>
<text x="610" y="202" font-size="19" font-style="italic" fill="var(--sl-color-text)" text-anchor="middle">“Which rule applies here,</text>
<text x="610" y="225" font-size="19" font-style="italic" fill="var(--sl-color-text)" text-anchor="middle">and who said it?”</text>
</svg>
<figcaption class="cc-cmp-caption">Same phrase, different subject. One maps your data. The other maps what you decided about your work.</figcaption>
</figure>

## Side by side

|  | OpenMetadata | ContextCake |
| --- | --- | --- |
| **What it indexes** | Data assets — tables, columns, dashboards, pipelines, models | Written knowledge — decisions, standards, runbooks, notes |
| **Where the truth lives** | A server you run: MySQL for entities, Elasticsearch for search | Markdown files in git repos you already own |
| **How it gets the data** | Python crawlers pull from 130+ connected systems | It reads the folders and repos you point it at |
| **When two sources disagree** | People review and approve one value | Higher layer wins per section; the other rides along, dated |
| **What you install** | Docker or Kubernetes, plus a database and a search engine | One command, or a Mac app. No database, no services |
| **Who runs it** | A data platform team | One person, then their team |
| **How AI reads it** | MCP server, under the same permissions as a user | MCP server, reading the files you can already read |

## Where the truth lives

OpenMetadata copies your metadata into its own store. Crawlers run on a schedule and keep
that copy fresh. The catalog becomes the place you look things up, and it has to stay up.

ContextCake never copies anything. A layer is a folder of Markdown or a git repo. Add the
folder, and it is a layer. Read access is repo access — if you can clone it, you can read
it, and if you cannot, it never reaches your agent. See
[the layer cake](/docs/concepts/layer-cake).

## The difference that matters most

A catalog wants one right answer. Someone proposes a value, someone approves it, and that
value becomes the record. This is the correct design for a column description. Two teams
should not disagree about what `orders.total` means.

Written rules do not behave that way. The company sets a standard. Your team documents an
approved exception. You carry a constraint that only applies to the machine in front of
you. All three can be true at once, at different scopes. Flattening them into one approved
value throws away the part that makes the answer safe.

<figure class="cc-cmp-figure">
<svg viewBox="0 0 800 300" role="img" aria-labelledby="cc-fig2-title">
<title id="cc-fig2-title">A catalog collapses three competing values into one approved value and drops the rest. ContextCake ranks them, returns the winner, and carries the disagreement along with its date.</title>
<defs><marker id="cc-a2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--sl-color-gray-4)" /></marker></defs>
<line x1="400" y1="14" x2="400" y2="286" stroke="var(--sl-color-hairline)" stroke-width="1" />
<text x="20" y="28" font-size="18" font-weight="700" fill="var(--sl-color-text)">A catalog converges</text>
<g font-size="17" fill="var(--sl-color-text)">
<rect x="20" y="46" width="340" height="30" rx="7" fill="none" stroke="var(--sl-color-gray-4)" /><text x="34" y="66">Company says: Postgres</text>
<rect x="20" y="82" width="340" height="30" rx="7" fill="none" stroke="var(--sl-color-gray-4)" /><text x="34" y="102">Team says: SingleStore</text>
<rect x="20" y="118" width="340" height="30" rx="7" fill="none" stroke="var(--sl-color-gray-4)" /><text x="34" y="138">You say: read replica only</text>
</g>
<path d="M190 152 L190 174" stroke="var(--sl-color-gray-4)" stroke-width="1.5" marker-end="url(#cc-a2)" />
<rect x="20" y="178" width="340" height="44" rx="10" fill="var(--cc-layer-company)" />
<text x="190" y="206" font-size="18" font-weight="700" fill="#151917" text-anchor="middle">SingleStore — approved</text>
<rect x="20" y="230" width="340" height="44" rx="10" fill="none" stroke="var(--sl-color-gray-4)" stroke-dasharray="5 4" />
<text x="190" y="251" font-size="17" fill="var(--sl-color-gray-3)" text-anchor="middle">the other two values</text>
<text x="190" y="267" font-size="16" fill="var(--sl-color-gray-3)" text-anchor="middle" font-family="var(--cc-font-mono)">not in the answer</text>
<text x="440" y="28" font-size="18" font-weight="700" fill="var(--sl-color-text)">ContextCake ranks and keeps</text>
<g font-size="17" fill="#151917">
<rect x="440" y="46" width="340" height="30" rx="7" fill="var(--cc-layer-personal)" /><text x="454" y="66">You say: read replica only</text>
<rect x="440" y="82" width="340" height="30" rx="7" fill="var(--cc-layer-team)" /><text x="454" y="102">Team says: SingleStore</text>
<rect x="440" y="118" width="340" height="30" rx="7" fill="var(--cc-layer-company)" /><text x="454" y="138">Company says: Postgres</text>
</g>
<path d="M610 152 L610 174" stroke="var(--sl-color-gray-4)" stroke-width="1.5" marker-end="url(#cc-a2)" />
<rect x="440" y="178" width="340" height="44" rx="10" fill="var(--cc-layer-team)" />
<text x="610" y="199" font-size="18" font-weight="700" fill="#151917" text-anchor="middle">SingleStore</text>
<text x="610" y="215" font-size="16" fill="#151917" text-anchor="middle" font-family="var(--cc-font-mono)">team · 2026-03-04</text>
<rect x="440" y="230" width="340" height="44" rx="10" fill="none" stroke="var(--cc-conflict)" stroke-width="1.5" />
<text x="610" y="251" font-size="17" fill="var(--sl-color-text)" text-anchor="middle">also on record: Postgres</text>
<text x="610" y="267" font-size="16" fill="var(--sl-color-gray-2)" text-anchor="middle" font-family="var(--cc-font-mono)">company · 2026-01-12</text>
</svg>
<figcaption class="cc-cmp-caption">The catalog picks a winner and drops the rest. ContextCake picks a winner and shows you what it beat, with the date.</figcaption>
</figure>

The disagreement is the product. See
[conflicts and provenance](/docs/concepts/conflicts-and-provenance) for what an agent
actually receives.

## What OpenMetadata does better

If you are choosing between the two for data work, choose OpenMetadata. It is a mature
tool with real strengths we do not match and are not trying to match:

- **130+ connectors.** Snowflake, dbt, Airflow, Looker, Tableau, S3. We have none of this.
- **Column-level lineage.** Change a column, see every dashboard that breaks.
- **A permission engine.** Roles, policies, domains, approval workflows. Our access model
  is repo membership, which is simpler and much less precise.
- **A formal ontology.** 700+ published schemas in JSON Schema and RDF. If your company
  needs its metadata to speak a W3C standard, they have that and we do not.
- **Data quality tests and contracts**, wired into the same graph.

## Which one do you need

<div class="cc-cmp-split">
<div class="cc-cmp-card cc-cmp-card--om">

### Reach for OpenMetadata

- You have a warehouse and nobody can find the right table.
- You need to know what breaks when a column changes.
- You want owners, quality checks, and approvals on your data.
- You have a platform team to run it.

</div>
<div class="cc-cmp-card cc-cmp-card--cc">

### Reach for ContextCake

- Your agent keeps ignoring a rule that lives in someone's head.
- Your team's practice differs from the company standard, on purpose.
- You want to see why the agent was told something, not just what.
- You want to start today, alone, without asking anyone for a server.

</div>
</div>

Most teams that want one do not want the other instead. They want both.

## They stack

ContextCake reads a [foreign MCP source](/docs/guides/foreign-mcp-sources) as a layer. If
your company already runs OpenMetadata, point a layer at it. Its graph joins the cascade
as one more source, under the same precedence rules as everything else — and your team
notes can speak over it without editing the catalog.

<figure class="cc-cmp-figure">
<svg viewBox="0 0 800 262" role="img" aria-labelledby="cc-fig3-title">
<title id="cc-fig3-title">An OpenMetadata deployment can act as one layer inside a ContextCake cascade, read over MCP, with team and personal layers stacked above it.</title>
<defs><marker id="cc-a3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--sl-color-gray-4)" /></marker></defs>
<text x="20" y="28" font-size="18" font-weight="700" fill="var(--sl-color-text)">One cascade. One of the layers is OpenMetadata.</text>
<g fill="#151917">
<rect x="20" y="50" width="330" height="44" rx="9" fill="var(--cc-layer-personal)" />
<text x="36" y="71" font-size="17" font-weight="600">Your notes</text>
<text x="36" y="88" font-size="16" font-family="var(--cc-font-mono)">level 3 · local folder</text>
<rect x="20" y="100" width="330" height="44" rx="9" fill="var(--cc-layer-team)" />
<text x="36" y="121" font-size="17" font-weight="600">Team practice</text>
<text x="36" y="138" font-size="16" font-family="var(--cc-font-mono)">level 2 · git repo</text>
<rect x="20" y="150" width="330" height="44" rx="9" fill="var(--cc-layer-company)" />
<text x="36" y="171" font-size="17" font-weight="600">OpenMetadata</text>
<text x="36" y="188" font-size="16" font-family="var(--cc-font-mono)">level 0 · source: mcp</text>
</g>
<path d="M356 122 L 428 122" stroke="var(--sl-color-gray-4)" stroke-width="1.5" marker-end="url(#cc-a3)" />
<text x="392" y="113" font-size="16" fill="var(--sl-color-gray-3)" text-anchor="middle" font-family="var(--cc-font-mono)">resolve</text>
<rect x="435" y="92" width="160" height="60" rx="10" fill="none" stroke="var(--sl-color-gray-4)" />
<text x="515" y="118" font-size="18" font-weight="600" fill="var(--sl-color-text)" text-anchor="middle">ContextCake</text>
<text x="515" y="139" font-size="15" fill="var(--sl-color-gray-2)" text-anchor="middle">merges by section</text>
<path d="M601 122 L 673 122" stroke="var(--sl-color-gray-4)" stroke-width="1.5" marker-end="url(#cc-a3)" />
<text x="637" y="113" font-size="16" fill="var(--sl-color-gray-3)" text-anchor="middle" font-family="var(--cc-font-mono)">MCP</text>
<rect x="680" y="92" width="100" height="60" rx="10" fill="none" stroke="var(--sl-color-gray-4)" />
<text x="730" y="127" font-size="18" font-weight="600" fill="var(--sl-color-text)" text-anchor="middle">Your agent</text>
<text x="20" y="236" font-size="16" fill="var(--sl-color-gray-2)">The catalog stays where it is. Nothing is copied, and nobody edits it to add an exception.</text>
</svg>
<figcaption class="cc-cmp-caption">The foreign graph is translated to OKF at read time. The catalog is not modified, and it does not have to know we exist.</figcaption>
</figure>

Pointing a layer at a system you do not control is a trust decision. Read
[the trust boundary](/docs/concepts/trust-boundary) first.

## In one line

OpenMetadata tells your agent **what your data is**. ContextCake tells it **what you
decided** — and who it should believe when the answers differ.

## Next

- [The layer cake](/docs/concepts/layer-cake) — the model underneath all of this
- [Conflicts and provenance](/docs/concepts/conflicts-and-provenance) — what an answer carries
- [ContextCake and agent memory](/docs/concepts/agent-memory-comparison) — the other comparison people ask for
- [Foreign MCP sources](/docs/guides/foreign-mcp-sources) — how to attach an existing system
