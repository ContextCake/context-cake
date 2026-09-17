// Locating YAML frontmatter: an opening `---` line, then everything up to the
// next line that starts with `---`.
//
// The one place that knows a fence may end in CRLF. Readers used to test
// `startsWith("---\n")` on their own, so a file saved with Windows line
// endings parsed as having no frontmatter at all and lost its type, title, and
// dates without a warning. Keep fence detection here; callers only parse
// `raw` (split it on /\r?\n/) and reassemble with `newline`.

/**
 * @returns {null | { newline: "\n" | "\r\n", open: number, raw: string, rest: string }}
 *   `open` is the length of the opening fence line, `raw` the field lines with
 *   no trailing line ending, `rest` everything after the closing `---`
 *   (starting with that line's ending). Null when there is no complete fence.
 */
export function splitFrontmatter(text) {
  const open = text.startsWith("---\r\n") ? 5 : text.startsWith("---\n") ? 4 : 0;
  if (!open) return null;
  const close = text.indexOf("\n---", open);
  if (close === -1) return null;
  const rawEnd = text[close - 1] === "\r" ? close - 1 : close;
  return {
    newline: open === 5 ? "\r\n" : "\n",
    open,
    raw: text.slice(open, rawEnd),
    rest: text.slice(close + 4),
  };
}
