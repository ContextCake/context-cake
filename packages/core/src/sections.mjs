// The one way to read a section's body text.
//
// Sections used to store `lines: string[]` — one JS string PER LINE, retained
// for the life of the snapshot. String headers plus UTF-16 widening made an
// 80MB vault cost 200–350MB of live heap before anything derived from it, and
// every consumer immediately did `.lines.join("\n")` anyway. Adapters now
// store one contiguous `text` per section; this helper keeps every consumer
// working over all three shapes a section can arrive in:
//
//   text     — the engine's own adapters (contiguous, the memory-cheap shape)
//   lines    — foreign/legacy producers and test fixtures
//   content  — an already-RESOLVED section (resolver output)
//
// Deliberately no `lines` compatibility getter on sections: it would silently
// re-pay the allocation this change removes.

export function sectionText(section) {
  if (typeof section?.text === "string") return section.text;
  if (Array.isArray(section?.lines)) return section.lines.join("\n");
  if (typeof section?.content === "string") return section.content;
  return "";
}

export function sectionHasContent(section) {
  return sectionText(section).trim() !== "";
}
