// `contextcake file` (control-plane spec §5.7, read half). Shims over
// control/query.mjs, which answers exactly what /api/files and /api/file
// answer, inside the same layer-root sandbox (layer-files.mjs). Config-only:
// no source adapter opens. Only folder layers (okf-local, files) own files.

import { listFilesOperation, readFileOperation } from "../../control/query.mjs";
import { selectProfileForRead } from "../read-selection.mjs";
import { defineFamily } from "../table.mjs";

function scope(ctx) {
  const { selection, manifest, quarantined } = selectProfileForRead(ctx);
  return { manifestPath: ctx.manifestPath, profileId: selection.profileId, manifest, quarantined, signal: ctx.signal };
}

export default defineFamily({
  name: "file",
  stability: "experimental",
  summary: "list and read the files inside folder sources",
  commands: [
    {
      name: "list",
      summary: "list every file in the profile's folder sources",
      mutation: "read",
      manifest: "required",
      profile: true,
      coverage: true,
      errors: ["MANIFEST_NOT_V2"],
      output: {
        type: "object",
        required: ["layers"],
        properties: {
          layers: {
            type: "array",
            items: {
              type: "object",
              required: ["layer", "kind", "root", "fileCount", "truncated", "error", "files"],
              properties: {
                layer: { type: "string" },
                kind: { enum: ["okf-local", "files"] },
                root: { type: "string" },
                fileCount: { type: "integer" },
                truncated: { type: "boolean" },
                error: { type: ["string", "null"] },
                files: {
                  type: "array",
                  items: { type: "object", required: ["path", "name", "rel", "ext", "kind", "markdown"] },
                },
              },
            },
          },
        },
      },
      async run(ctx) {
        const { data, coverage } = await listFilesOperation(scope(ctx));
        if (!coverage.complete) ctx.suggest("doctor", "contextcake doctor", "See why a source could not be read.");
        const lines = data.layers.length
          ? data.layers.flatMap((layer) => [
            `${layer.layer} (${layer.kind}) ${layer.root}: ${layer.error ? `error: ${layer.error}` : `${layer.fileCount} file(s)${layer.truncated ? ", truncated" : ""}`}`,
            ...layer.files.map((file) => `  ${file.path}`),
          ])
          : ["No folder sources in this profile."];
        return { data, coverage, text: lines.join("\n") };
      },
    },
    {
      name: "read",
      summary: "read one file by <layer>/<relative path>",
      mutation: "read",
      manifest: "required",
      profile: true,
      positionals: [{ name: "path", required: true, description: "File path as <layer>/<relative path>, as `file list` prints it." }],
      errors: ["NOT_FOUND", "PATH_OUTSIDE_LAYER", "MANIFEST_NOT_V2"],
      output: {
        type: "object",
        required: ["path", "layer", "rel", "ext", "kind", "editable", "markdown", "bytes", "modified"],
        properties: {
          path: { type: "string" },
          layer: { type: "string" },
          rel: { type: "string" },
          ext: { type: "string" },
          kind: { enum: ["text", "svg", "image", "pdf", "binary"] },
          editable: { type: "boolean" },
          markdown: { type: "boolean" },
          bytes: { type: "integer" },
          modified: { type: "string" },
          text: { type: "string" },
          reason: { type: "string" },
        },
      },
      async run(ctx) {
        const { data } = await readFileOperation({ ...scope(ctx), filePath: ctx.args.path });
        const text = typeof data.text === "string"
          ? data.text
          : `${data.path}: ${data.kind}, ${data.bytes} bytes${data.reason ? `. ${data.reason}` : ". Not a text file; use --json for its metadata."}`;
        return { data, text };
      },
    },
  ],
});
