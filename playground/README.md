# ContextCake · Cascade Playground

An interactive canvas for *seeing* the cascade engine work. Sources are nodes;
each concept resolves live through `resolver.mjs`, and where layers disagree the
conflict is surfaced on the section — never dropped.

```bash
npm run playground          # serves http://127.0.0.1:8790
# or point it at a different manifest / port:
node playground/server.mjs --manifest layers.json --port 8790
```

Then open <http://127.0.0.1:8790>.

## Sources & context budget

The **Sources** tab is the configuration + accounting surface:

- **Add sources** of three kinds:
  - **Local path** — a directory of OKF markdown (relative to the manifest, or absolute).
  - **GitHub repo** — cloned with `git` (uses your credentials, so private repos
    work). Give `owner/name`, an https URL, or an SSH URL, plus an optional
    branch/sub-directory. The repo may or may not contain OKF — non-OKF markdown
    just yields fewer concepts. **Sync** does a `git pull`. Clones live in
    `playground/.cache/` (gitignored). Only `owner/name` / https / SSH forms are
    accepted; other git transports are rejected.
  - **MCP server** — a `command` + `args` that speak MCP; their graph is
    translated to OKF at read time. (This spawns the command — only add servers
    you trust; the manifest is a trust boundary.)
- **Token accounting** — every source and concept is tokenized with a vendored
  **o200k_base** BPE tokenizer (GPT-4o's; a close proxy for Claude, which isn't
  public). The budget bar shows each source's share of the total context, and
  `raw → effective` shows how much the cascade dedups (e.g. 772 raw → 603 after
  merge). No npm, no network — the tokenizer is vendored under `vendor/tiktoken/`.
- Remove a source, change its precedence, or watch a broken source (down MCP,
  missing clone) show an **error** status without taking down the rest.

Adding/removing a source edits `playground/manifest.json` in place.

## What you're looking at

- **Canvas** — each layer/source is a draggable card, arranged by precedence
  (highest level on top), fanning into a single **Resolved concept** node. Drag
  to pan, scroll to zoom, drag a card to move it.
- **Left rail** — every concept across all layers. A ⚠ badge means the layers
  disagree on at least one section. The colored dots show which layers contribute.
- **Inspector** (right) — select a concept to see the effective merge:
  - the **precedence chain** (which layer outranks which),
  - **frontmatter provenance** (which layer set each field),
  - **merged sections**, each tagged with the layer that won it, and
  - **conflict panels** — the dissenting layers with their dates and content,
    surfaced inline. This is the "surface, don't hide" policy made visible.
  - Click a **source node** instead to inspect that source's metadata and the
    concepts it contributes to.
- **Sync** re-reads the sources from disk, so you can edit the demo OKF markdown
  in `playground/demo-layers/` and watch the cascade change on refresh.

## Resolving conflicts

Surfacing a conflict is the default; resolving one is opt-in. Each conflicted
section in the inspector has a **Resolve…** button that opens an N-way merge tool:

- Every layer's version of that section is shown side by side (winner tagged),
  with its `updated` date.
- Click **Use this value** to load any version into the editor, or compose a
  reconciled value by hand.
- **Apply resolution** writes your value into every layer that defines the
  section, so they agree — the conflict clears and the cascade re-resolves. The
  tool always shows exactly which layers it will write to first.

This mutates real files (same layer-root sandbox, text-only). It's the human
deciding the canonical value — nothing is auto-merged.

## Files mode

Toggle **Files** in the top bar for a live explorer/editor over the same layer
bundles:

- **Tree** — every file under each manifest source, grouped by layer.
- **Editor** — CodeMirror with syntax highlighting for the file's type. Text
  files (markdown, code, SVG) are editable.
- **Preview** — markdown rendered as prose (sanitized), SVG and raster images
  rendered as images, PDFs rendered by pdf.js. Use the Split / Source / Preview
  toggle for text files.
- **Save = live re-resolve.** Editing a layer's OKF markdown and saving writes it
  to disk and re-runs the cascade — the conflict count on the file's concept
  chip (and the canvas) updates immediately. Remove `personal`'s `Choice`
  section, save, and watch `decisions/primary-db` drop from 2 conflicts to 1.

Writes are sandboxed to the manifest's layer roots (path-traversal and symlink
guarded, text files only). State-changing requests require a loopback `Host` and
same-origin (CSRF/DNS-rebinding guard), and rendered source content is sanitized
(markdown via DOMPurify; SVG shown as an inert image) since a source can be any
repo. The libraries (CodeMirror, marked, DOMPurify, pdf.js, and the o200k
tokenizer) are **vendored** under `playground/vendor/` — no CDN, no npm, works
offline. The engine itself stays dependency-free.

## The demo data

`playground/demo-layers/` holds three tiny OKF bundles wired up by
`playground/manifest.json`:

| Layer | Level | Role |
|-------|-------|------|
| `company` | 0 | Org baseline |
| `team` | 2 | Overrides + adds |
| `personal` | 3 | Highest precedence |

`decisions/primary-db` is the interesting one: `personal` wins **Choice**,
`team` wins **Rationale** (both surface `company` as a conflict), while
**Ownership** and **Related** are inherited untouched from `company`. Edit any of
these files and hit **Sync** to see the merge react.

## How it fits

The server is a thin, dependency-free shell over the real engine — it does not
reimplement resolution. `GET /api/graph` returns the source topology + concept
index; `GET /api/resolve?concept=<id>` returns exactly what the CLI and MCP
server would. The browser is just another reader of that output.

Point `--manifest` at your own bundle to explore real layers. As with any
manifest, only point it at configs you trust — an `mcp` layer spawns a command.
