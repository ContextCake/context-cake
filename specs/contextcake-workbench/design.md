# Context workbench

ContextCake's primary work is finding useful context, reading it with its evidence,
and addressing disagreement. A dashboard dominated by cascade diagrams, counters,
and maintenance controls gives those activities too little room.

## Information architecture

- Workspace: one search entry, indexed context and available section update dates,
  source health, and the next useful action.
- Library: full-width contextual search and filters above a document navigator and
  reading surface. Original search excerpts stay distinguished from resolved content.
- Trust: a decision inbox with evidence at its center. Automation and history are
  secondary tools, available without dominating every visit.
- Sources: connections and health in a navigator/inspector. Ordering remains explicit.
- Map: a secondary visual explanation of the cascade.

Internal route IDs and deep links remain stable. Existing grouped-view preferences,
keyboard shortcuts, dirty-editor navigation guards and native commands remain valid.
A compact labelled navigation rail is the default for new installations; expansion
and existing width preferences remain available. The installed validation uses the rail.

## Visual system

A compact rail, 64px toolbar and distinct navigator/reading surfaces replace the
wide-sidebar dashboard composition. Spacing follows 4/8/12/16/24/32px increments.
System typography belongs in native Mac chrome; monospace is reserved for identifiers.
Body and reader text have more room than metadata. User-selected color themes remain
supported. Responsive detail sheets retain focus restoration and keyboard handling.

## Truthfulness and states

Only indexed data and actual section dates drive activity. No fabricated recents,
engagement scores or verified-correct claims. Loading, partial indexing, inaccessible
sources, empty results and failed requests remain explicit. Policies preserve source
files. Models provide cited advice; neither model confidence nor a successful model
connection authorizes unattended semantic changes.

## Validation

Run console behavior tests, typecheck and build; desktop tests after native menu and
default changes. Reinstall the actual app, exercise real sources, search/reader,
Trust history and responsive layout, and verify source manifests remain unchanged.
