// Conflict policy: when does a dissenting section count as a real disagreement,
// and when is a dissent fresher than the value that beat it?
//
// `equivalent` exists because byte-equality made formatting noise into
// conflicts: a teammate re-saving a doc with an editor that trims trailing
// whitespace or prefers `-` bullets would raise a "disagreement" whose two
// sides say the same thing. The normalization here is deliberately narrow —
// whitespace and unordered-bullet glyphs only. Anything that could change
// meaning (case, punctuation, ordered-list markers, Unicode normalization,
// line reordering) stays a conflict; when in doubt, surface it. Dependency-free.

// True iff the two texts are identical after per-line formatting
// normalization: (1) trailing spaces/tabs stripped; (2) a leading unordered
// bullet `*` or `+` (at most 3 leading spaces, followed by a space) reads as
// `-`; (3) runs of 2+ blank lines collapse to one, and leading/trailing blank
// lines drop. Ordered markers (`1.` vs `1)`) are NOT normalized — renumbering
// intent is meaning, not formatting.
export function equivalent(a, b) {
  if (a === b) return true;
  return normalizeFormatting(a) === normalizeFormatting(b);
}

function normalizeFormatting(text) {
  const lines = String(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, "").replace(/^( {0,3})[*+](?= )/, "$1-"));

  const collapsed = [];
  for (const line of lines) {
    if (line === "" && collapsed[collapsed.length - 1] === "") continue;
    collapsed.push(line);
  }
  while (collapsed[0] === "") collapsed.shift();
  while (collapsed[collapsed.length - 1] === "") collapsed.pop();
  return collapsed.join("\n");
}

// True iff `candidate` is strictly newer than `reference` at day granularity.
// Both values must parse as dates (`new Date(v).getTime()` valid) — a missing
// or unparseable date on either side means "unknown", never epoch 0, so no
// freshness claim is made. Day granularity compares the first 10 characters
// (ISO `YYYY-MM-DD` prefix): MCP layers carry arbitrary `lastTouched`
// datetimes, and a datetime must not read as fresher than a same-day
// date-only value.
export function isNewerDay(candidate, reference) {
  const candidateDay = dayStamp(candidate);
  const referenceDay = dayStamp(reference);
  if (candidateDay === null || referenceDay === null) return false;
  return candidateDay > referenceDay;
}

function dayStamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return String(value).slice(0, 10);
}
