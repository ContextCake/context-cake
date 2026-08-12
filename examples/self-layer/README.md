# ContextCake's own layer

A real OKF bundle, not a fixture: these five concepts are ContextCake's own
architecture decisions, authored in the format the engine reads. Useful as a
worked example of what a hand-written layer looks like, and as something to
point an agent at while working on the engine itself.

```bash
# Resolve one concept
node resolver.mjs --manifest examples/self-layer/manifest.json --concept decisions/conflict-policy

# Or serve it to an agent
node mcp-server.mjs --manifest examples/self-layer/manifest.json
```

| Concept | What it records |
|---------|-----------------|
| `architecture/overview` | What ContextCake is, and what it is not |
| `decisions/layer-structure` | Why layers are named and levelled the way they are |
| `decisions/resolution-model` | Section-level merge rather than whole-document replacement |
| `decisions/conflict-policy` | Surface disagreement instead of hiding it |
| `decisions/source-contract` | What a source adapter must implement |

These documents describe intent. Where they disagree with the code, the code
is what ships — but the disagreement is worth resolving rather than ignoring.
