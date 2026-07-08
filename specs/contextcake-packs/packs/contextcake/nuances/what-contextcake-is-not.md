---
type: nuance
updated: 2026-07-08
---

# What ContextCake is not {#what-contextcake-is-not}

The one-sentence description says what ContextCake does. This file is the
mirror image: the things people reasonably assume it is, that it deliberately
is not.

## Not a knowledge store, database, or source of truth {#not-a-knowledge-store}

ContextCake owns nothing. Every layer's knowledge lives exactly where it
lived before ContextCake showed up — a git repo of OKF markdown on disk, or
a foreign graph behind an MCP server. The resolver reads those sources fresh
at request time and hands back a stitched view; it does not copy the data
into a database, does not cache a merged snapshot as a new authoritative
copy, and does not become the place anyone should go to *edit* knowledge.
Edit the layer, not a ContextCake-owned copy — there isn't one. If you
deleted the resolver and the MCP server entirely, every layer's knowledge
would be completely intact and exactly as authoritative as before.

This also means ContextCake never resolves *disputes* about what is true —
it resolves *precedence*, which is a much narrower and more honest claim.
See `nuances/conflicts-are-surfaced-not-hidden.md` for how it represents
disagreement instead of adjudicating it.

## Not a graph database with node-level access control {#not-a-graph-database-with-rbac}

There is no per-node or per-field permission system inside ContextCake, and
none is planned. Access control is inherited entirely from whatever already
gates each layer's underlying source — in the common case, git repo
membership. If you can clone the team repo, you can read everything in the
team layer through ContextCake; if you cannot, that layer simply does not
contribute to your resolved view. There is no finer-grained control than
"which repos can you read," and no ContextCake-specific ACL to configure,
audit, or get out of sync with reality.

This is a feature, not a missing feature: it means access control is exactly
as strong (or weak) as your existing repo permissions, with nothing new to
maintain. But it also means ContextCake cannot do things a real graph
database with RBAC could — like letting one person see a sensitive section
of a concept that a teammate with the same repo access cannot.

## Not a silent auto-merger {#not-a-silent-auto-merger}

ContextCake never resolves a disagreement between layers by quietly picking
one side and dropping the other. Every conflict — same section, different
content, different layers — is preserved and surfaced with its source layer
and date, not merged away into a single blended answer and not silently
overwritten. See `nuances/conflicts-are-surfaced-not-hidden.md` for the
exact shape of that surfacing. The only things that behave like a merge
override are the two explicit, opt-in mechanisms in the override table:
`override: full` (whole-concept replacement, stated in frontmatter) and
`{#anchor override=none}` (a tombstone that blanks one inherited section,
retained as `suppressed: true` for audit). Both require the higher layer to
say so explicitly — nothing is suppressed or merged away by inference.

## The manifest is a trust boundary, not a config file {#the-manifest-is-a-trust-boundary}

This is not a "what it's not" claim so much as a related warning worth
repeating here: an `mcp`-sourced layer in `layers.json` spawns `command`
with `args` taken directly from that file. A manifest is not inert
configuration — pointing `--manifest` at a file you did not author or trust
means letting it run arbitrary commands as your user, exactly like pointing
any MCP client at an untrusted server config. Treat `layers.json` with the
same suspicion you would treat any other executable-adjacent config, not the
same casualness you'd give a `.env` file.

## Next {#next}

- `overview/what-is-contextcake.md` — what it actually is, stated positively
- `nuances/dependency-free-engine.md` — why the engine's trust surface is
  kept deliberately small
- `nuances/conflicts-are-surfaced-not-hidden.md` — how disagreement is
  represented instead of merged away
