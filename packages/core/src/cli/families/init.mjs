// `contextcake init` (control-plane spec §5.3, §5.13): creates a v2 manifest
// at the platform config path, or --manifest. It never migrates: an existing
// manifest of any valid shape is left byte-for-byte alone, so running init
// twice, or after the app created a manifest, is safe.

import fs from "node:fs";
import { classifyManifest, createContextManifest, manifestRevision } from "../../manifest.mjs";
import { manifestControlError } from "../../control/errors.mjs";
import { defineFamily } from "../table.mjs";

export const EMPTY_V2_MANIFEST = Object.freeze({ profiles: { default: { label: "Default", layers: [] } } });

export default defineFamily({
  name: "init",
  stability: "stable",
  summary: "create a manifest if there is none",
  commands: [
    {
      summary: "create an empty v2 manifest; leave an existing one untouched",
      mutation: "write",
      manifest: "creates",
      output: {
        type: "object",
        required: ["manifestPath", "created", "mode"],
        properties: {
          manifestPath: { type: "string" },
          created: { type: "boolean" },
          mode: { enum: ["v2", "legacy", "transitional"] },
        },
      },
      run(ctx) {
        const manifestPath = ctx.manifestPath;
        let created = false;
        if (!fs.existsSync(manifestPath)) {
          try {
            createContextManifest(manifestPath, structuredClone(EMPTY_V2_MANIFEST));
            created = true;
            // Report what we wrote, not a later read another writer could beat.
            ctx.noteManifestWrite(manifestRevision(EMPTY_V2_MANIFEST));
          } catch (error) {
            // Another process created it between our check and the exclusive
            // link: fall through and report what is there now.
            if (!/Refusing to overwrite existing file/.test(error.message)) throw manifestControlError(error);
          }
        }
        // An existing manifest that fails validation is refused (exit 7), never
        // overwritten.
        const mode = created ? "v2" : classifyManifest(ctx.readManifest());
        ctx.setContext({ profileId: "default", profileReason: "default" });
        if (mode !== "v2") {
          ctx.warn("MANIFEST_NOT_V2", `The existing ${mode} manifest was left unchanged; init never migrates.`, { mode });
          ctx.suggest("profile.create", "contextcake profile create <label>", "Creating a profile migrates the manifest to v2 with a verified backup.");
        }
        ctx.suggest("source.add", "contextcake source add <name> --path <folder>", "Add a folder of Markdown as a source.");
        ctx.suggest("mcp", "contextcake mcp", "Serve the manifest to an MCP client.");
        const data = { manifestPath, created, mode };
        const text = created
          ? `Created ${manifestPath}`
          : `A ${mode} manifest already exists at ${manifestPath}. Nothing changed.`;
        return { data, text };
      },
    },
  ],
});

