# Conflict Resolution Design

## Interaction

The Conflicts view has two states: `Needs you` and `Resolved`. The top summary counts conflicts that need judgment and conflicts that are safe to resolve. When safe items exist, one wand action resolves them sequentially and reports any item that could not be applied.

An open conflict asks one question: **Which answer should ContextCake use?** Each contribution is a radio-style answer showing the layer, full value, update date, and only decision-relevant flags such as `Used now` or `Newer`. The primary button repeats the selected action: **Use the Team answer**.

A resolved conflict shows the chosen answer first, followed by a compact history. **Change decision** restores the original answer choices saved with the latest record. No explanation field is required; speed is the default and the deterministic record already says why an automatic decision was safe.

## Safe Classification

Automatic resolution is deliberately lexical, not semantic:

1. Unicode-normalize and lowercase each value.
2. Remove Markdown emphasis markers.
3. Replace punctuation and whitespace with token boundaries.
4. Compare the resulting word-and-number token sequence.

The classifier refuses empty signatures and content with code fences, inline code, links, images, HTML, tables, or URLs. If all remaining token sequences match exactly, ContextCake may keep the current effective value. Any different, missing, or reordered token requires a person.

The server re-runs this classification. A client cannot label a semantic conflict safe by changing the request.

## Write Contract

`POST /api/conflict-resolutions` accepts a concept id, section key, selected layer, method, and optional prior resolution id.

For a new conflict, the service resolves current source state and builds the choice set from the effective section plus its dissent. For a changed decision, it loads the saved choice set from the referenced record. It serializes decisions through the manifest lock, then loads and preflights every target file, verifies that each current section equals the expected snapshot, and requires every contributing layer to be writable before any write occurs. File sources retain their existing `.md`, `.mdx`, and `.txt` support.

The chosen content is written through the existing section replacement path. The source index is invalidated after success.

## Decision Log

Records append to `.contextcake/conflict-resolutions.ndjson` beside the manifest. The directory is local, hidden from the Files browser, and created only on the first resolution.

Each record contains:

- schema version and unique id;
- stable conflict id (`concept::section-key`);
- concept title, section heading, and section key;
- original layer names, precedence levels, values, and update dates;
- chosen layer and value;
- `automatic` or `manual` method;
- a short deterministic reason;
- `local-user` actor label and ISO timestamp;
- optional `supersedes` id.

The file is append-only. The API returns all valid records; the console groups them by conflict id and treats the newest as current.

## Failure Semantics

- Unsupported/read-only contributor: `409`, no writes.
- Source value no longer matches the staged snapshot: `409`, no writes.
- Automatic method fails the server classifier: `409`, no writes.
- Malformed request or record: `400`.
- Mutations disabled: existing `405` service behavior.
- Decision-log directory cannot be prepared: fail before source writes.

The UI keeps the conflict open, preserves the selected choice, and shows the server’s plain error beside the action.
