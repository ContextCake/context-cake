// How a background index entry is named.
//
// Three strings, deliberately different, because they answer three different
// questions about one layer:
//
//   identity — what this source READS. Everything in the layer that decides
//     that, with `name` and `level` left out: both are presentation, resolved
//     off the live source object when a concept is read (see snapshotView), so
//     a rename or a precedence change must cost nothing.
//
//   validity — identity plus the policy that governed the read: the indexing
//     settings, and the credential epoch for a layer that names a credential.
//     An entry whose validity still matches a live layer is STILL A CORRECT
//     INDEX of it, so it can be carried across a re-key. One whose validity
//     moved cannot: the user lowered a document cap, or disconnected an
//     account, and the answer that entry holds was produced under rules that
//     no longer apply.
//
//   key — validity plus the layer ROW it belongs to. This is what `indexes` is
//     keyed by, and it must be unique per row: two rows sharing one entry means
//     one source's documents are served under the other's name and level.
//
// The row segment is the layer name (unique per manifest by validation), and
// the whole list is uniquified afterwards regardless — a manifest that somehow
// reaches this code with two identical rows gets two entries, not one shared
// one. Key uniqueness is a structural property here, not a claim about which
// field combinations a user can produce.

import { stableJson } from "./manifest.mjs";

// A denylist rather than a list of known identity fields, on purpose: a source
// option added later changes what gets read until someone proves otherwise, so
// anything new must invalidate the index by default.
export const PRESENTATION_FIELDS = new Set(["name", "level"]);

/**
 * A layer's content identity.
 *
 * The kind gets a RESERVED SLOT rather than a spot in the same flat object as
 * the layer's own fields. `kind` is not a reserved layer field — validateLayer
 * accepts unknown keys and the desktop app's settings sync writes one — so a
 * flat object let a layer field literally named `kind` overwrite the source
 * kind and collide with an unrelated layer's identity. That collision was a key
 * collision, i.e. one index entry serving two sources: a local folder reported
 * a foreign MCP server's documents as its own and won the merge with them.
 *
 * Nesting every user field one level down makes that impossible to express:
 * a layer field named `kind` is `fields.kind` and a layer field named `fields`
 * is `fields.fields`. The null-prototype object is the same argument applied to
 * `__proto__`, which plain assignment would swallow instead of storing.
 */
export function layerIdentity(layer) {
  const fields = Object.create(null);
  for (const [field, value] of Object.entries(layer ?? {})) {
    if (field === "source" || PRESENTATION_FIELDS.has(field)) continue;
    fields[field] = value;
  }
  // Normalized rather than copied through, so a manifest rewrite that spells
  // out the default kind does not re-read the whole source.
  return stableJson({ kind: layer?.source ?? "okf-local", fields });
}

/**
 * The validity and key strings for one rebuild's worth of rows.
 *
 * `rows` is [{ name, identity, epoch }] — the caller decides which layers a
 * credential epoch applies to, because a token that arrives after an anonymous
 * GitHub index must invalidate that index while connecting an account must not
 * rescan every local folder and MCP graph in the cascade.
 */
export function indexEntryKeys(rows, settings) {
  const policy = `${stableJson(settings)}`;
  const validities = rows.map((row) => `${row.identity}::${policy}::t${row.epoch ?? 0}`);
  const keys = uniquify(validities.map((validity, i) => `${validity}::n${JSON.stringify(String(rows[i]?.name ?? ""))}`));
  return { validities, keys };
}

// Last line of defence for key uniqueness: identical rows get an occurrence
// ordinal instead of silently sharing one index entry. First occurrence keeps
// the bare string, so the common case (every row distinct) is unaffected.
function uniquify(keys) {
  const seen = new Map();
  return keys.map((key) => {
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n === 0 ? key : `${key}::#${n}`;
  });
}
