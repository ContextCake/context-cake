# Link detection and repair share syntax spans

`markdown-links.mjs` returns source offsets for supported inline Markdown links
and wiki links. Discrepancy extraction, rewrite/unlink actions, and MCP graph
links consume this parser. A repair changes those exact offsets, from right to
left; it never scans the replacement text again during the same edit.

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
