// `contextcake concept` (control-plane spec §5.7, read half). Shims over
// control/query.mjs: `search` and `read` answer what /api/search and
// /api/resolve answer; `list` and `links` answer what MCP list_concepts and
// get_links answer. Each opens one selected-profile session and reports
// which sources it could not read in `coverage` (spec §5.2).

import {
  SEARCH_LIMIT_MAX,
  conceptLinksOperation,
  listConceptsOperation,
  readConceptOperation,
  searchConceptsOperation,
} from "../../control/query.mjs";
import { selectProfileForRead } from "../read-selection.mjs";
import { defineFamily } from "../table.mjs";

const LAYERS = { type: "array", items: { type: "string" } };

function suggestDoctor(ctx, coverage) {
  if (!coverage.complete) ctx.suggest("doctor", "contextcake doctor", "See why a source could not be read.");
}

function degradedLines(coverage) {
  return coverage.degraded.map((row) => `  ! ${row.source}: ${row.status}${row.reason ? ` (${row.reason})` : ""}`);
}

function withCoverageText(lines, coverage) {
  return coverage.complete ? lines.join("\n") : [...lines, "", "Some sources could not be read fully:", ...degradedLines(coverage)].join("\n");
}

function scope(ctx) {
  const selection = selectProfileForRead(ctx);
  return { manifestPath: ctx.manifestPath, profileId: selection.profileId };
}

export default defineFamily({
  name: "concept",
  stability: "experimental",
  summary: "list, search, read, and follow links between resolved concepts",
  commands: [
    {
      name: "list",
      summary: "list concept ids with their contributing layers",
      mutation: "read",
      manifest: "required",
      profile: true,
      coverage: true,
      errors: ["MANIFEST_NOT_V2"],
      flags: { type: { type: "string", description: "Only concepts whose effective type is this." } },
      output: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "type", "title", "layers"],
          properties: { id: { type: "string" }, type: { type: ["string", "null"] }, title: { type: ["string", "null"] }, layers: LAYERS },
        },
      },
      async run(ctx) {
        const { data, coverage } = await listConceptsOperation({ ...scope(ctx), type: ctx.flags.type ?? null });
        suggestDoctor(ctx, coverage);
        const lines = data.length
          ? data.map((row) => `${row.id}${row.type ? `  [${row.type}]` : ""}${row.title ? `  ${row.title}` : ""}  (${row.layers.join(", ")})`)
          : ["No concepts."];
        return { data, coverage, text: withCoverageText(lines, coverage) };
      },
    },
    {
      name: "search",
      summary: "rank concepts for a query, the way the app's search does",
      mutation: "read",
      manifest: "required",
      profile: true,
      coverage: true,
      errors: ["MANIFEST_NOT_V2"],
      positionals: [{ name: "query", required: true, variadic: true, description: "Search text; words are joined with spaces." }],
      flags: {
        type: { type: "string", description: "Only concepts whose effective type is this." },
        source: { type: "string", description: "Only hits from this source." },
        limit: { type: "integer", description: `Maximum hits (default 10, at most ${SEARCH_LIMIT_MAX}).` },
      },
      output: {
        type: "object",
        required: ["hits"],
        properties: {
          hits: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "title", "score", "layers", "snippet", "section", "inbound"],
              properties: {
                id: { type: "string" },
                title: { type: ["string", "null"] },
                score: { type: "number" },
                layers: LAYERS,
                snippet: { type: "string" },
                section: { type: ["object", "null"] },
                inbound: { type: "integer" },
                linksTo: LAYERS,
              },
            },
          },
        },
      },
      async run(ctx) {
        const { data, coverage } = await searchConceptsOperation({
          ...scope(ctx),
          query: ctx.args.query.join(" "),
          limit: ctx.flags.limit ?? 10,
          source: ctx.flags.source ?? null,
          type: ctx.flags.type ?? null,
        });
        suggestDoctor(ctx, coverage);
        if (data.hits[0]) ctx.suggest("concept.read", `contextcake concept read ${data.hits[0].id}`, "Read the top hit, with its conflicts.");
        const lines = data.hits.length
          ? data.hits.flatMap((hit, index) => [
            `${index + 1}. ${hit.id}${hit.title ? `  ${hit.title}` : ""}  (${hit.layers.join(", ")})`,
            ...(hit.snippet ? [`   ${hit.snippet.replace(/\s+/g, " ").trim()}`] : []),
          ])
          : ["No matches."];
        return { data, coverage, text: withCoverageText(lines, coverage) };
      },
    },
    {
      name: "read",
      summary: "read the resolved concept with provenance and conflicts",
      mutation: "read",
      manifest: "required",
      profile: true,
      coverage: true,
      positionals: [{ name: "id", required: true, description: "Concept id, e.g. decisions/primary-db." }],
      errors: ["NOT_FOUND", "MANIFEST_NOT_V2"],
      output: {
        type: "object",
        required: ["id", "frontmatter", "sections", "contributors"],
        properties: {
          id: { type: "string" },
          frontmatter: { type: "object" },
          contributors: { type: "array", items: { type: "object", required: ["layer", "level"] } },
          sections: {
            type: "array",
            items: {
              type: "object",
              required: ["key", "content", "sourceLayer"],
              properties: {
                key: { type: "string" },
                heading: { type: ["string", "null"] },
                content: { type: "string" },
                sourceLayer: { type: "string" },
                sourceUpdated: { type: ["string", "null"] },
                conflicts: { type: "array", items: { type: "object", required: ["layer", "content"] } },
                fresherDissent: { type: "boolean" },
                discrepancy: { type: "object" },
                contextResolution: { type: "object" },
              },
            },
          },
        },
      },
      async run(ctx) {
        const { data, coverage, markdown } = await readConceptOperation({ ...scope(ctx), conceptId: ctx.args.id });
        suggestDoctor(ctx, coverage);
        ctx.suggest("concept.links", `contextcake concept links ${data.id}`, "Follow its links.");
        return { data, coverage, text: withCoverageText([markdown], coverage) };
      },
    },
    {
      name: "links",
      summary: "show a concept's outgoing and incoming links",
      mutation: "read",
      manifest: "required",
      profile: true,
      coverage: true,
      positionals: [{ name: "id", required: true, description: "Concept id." }],
      errors: ["NOT_FOUND", "MANIFEST_NOT_V2"],
      output: {
        type: "object",
        required: ["source", "outgoing", "incoming"],
        properties: {
          source: { type: "object", required: ["id", "contributors"] },
          outgoing: {
            type: "array",
            items: { type: "object", required: ["raw", "target", "id", "layers"], properties: { raw: { type: "string" }, target: { type: "string" }, id: { type: ["string", "null"] }, layers: LAYERS } },
          },
          incoming: {
            type: "array",
            items: { type: "object", required: ["id", "layer", "raw"], properties: { id: { type: "string" }, layer: { type: "string" }, raw: { type: "string" } } },
          },
        },
      },
      async run(ctx) {
        const { data, coverage } = await conceptLinksOperation({ ...scope(ctx), conceptId: ctx.args.id });
        suggestDoctor(ctx, coverage);
        const lines = [
          `${data.source.id}`,
          "Outgoing:",
          ...(data.outgoing.length
            ? data.outgoing.map((link) => `  ${link.target} -> ${link.id ?? "(external)"}${link.id ? (link.layers.length ? `  (${link.layers.join(", ")})` : "  (missing)") : ""}`)
            : ["  none"]),
          "Incoming:",
          ...(data.incoming.length ? data.incoming.map((link) => `  ${link.id}  (${link.layer})`) : ["  none"]),
        ];
        return { data, coverage, text: withCoverageText(lines, coverage) };
      },
    },
  ],
});
