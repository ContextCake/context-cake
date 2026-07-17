# contextcake-packs

Private repository template for ContextCake Packs.

This repo holds paid pack content and Claude Code plugin packaging. Keep the README operational:
validation, packaging, fulfillment, and release commands only. Marketing copy belongs on the public
ContextCake site.

## Commands

Requires Node 18+ and the system `zip` command.

```bash
# Validate the scaffold and real pack content
bash scripts/validate-test.sh
node scripts/validate-okf.mjs

# Build the plain-file zip
node scripts/build-plain-zip.mjs
```

## Layout

```text
.claude-plugin/marketplace.json
packs/data-analytics-team/.claude-plugin/plugin.json
packs/data-analytics-team/skills/data-analytics-team-pack/
scripts/
RUNBOOK.md
```

The authored content root is:

```text
packs/data-analytics-team/skills/data-analytics-team-pack
```

That root is both the Claude Code skill content directory and the source for the plain zip.
The build copies only the allowlist, writes its canonical content-tree checksum into the
staged `PACK.yaml`, and emits a separate `.sha256` sidecar for archive transport integrity.
