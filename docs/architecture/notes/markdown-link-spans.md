# Link detection and repair share syntax spans

`markdown-links.mjs` returns source offsets for supported inline Markdown links
and wiki links. Discrepancy extraction, rewrite/unlink actions, and MCP graph
links consume this parser. A repair assembles untouched original spans and
replacement text in one pass and joins them once; it never scans replacement
text again or copies the entire document for each match during the same edit.

Delimiter boundaries are indexed in linear passes. Destination parsing reuses
suffix boundaries for balanced parentheses, angle destinations, whitespace,
and titles, so repeated unfinished link prefixes cannot repeatedly scan the
remaining document. Valid long destinations retain their original spans.
Wiki alias searches are confined to each link's own span; a sequence of plain
wiki links never searches the remaining document for an absent alias.
Literal HTML opening tags reuse the next closing angle bracket, including an
absent bracket. Backtick runs pair by length within each unfenced block in a
backwards pass, keeping unmatched runs literal without repeated suffix scans.

Backtick spans (including multiline and variable-length delimiters), fenced
code, indented examples, HTML comments, and literal HTML pre/code/script/style
regions are excluded. Escaped opening brackets and images are excluded too.
Destinations are separate from Markdown titles; balanced parentheses, angle
brackets, aliases, anchors, and existing surrounding whitespace are preserved.
Unclosed fences remain literal through EOF; unmatched inline ticks are text.

This dependency-free parser deliberately supports a bounded syntax contract,
not every CommonMark extension. Reference-style links are not detected or edited.
Four-space-indented lines are conservatively treated as literal examples, even
when a full Markdown list parser could interpret them as continuation text.
Broader detection needs corresponding lossless repair tests before automation
can operate on it. Candidate similarity still does not prove a rename.
