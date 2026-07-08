# Team Knowledge System Conventions

## Bundle Layout

Personal bundle:

```text
knowledge-personal/
  scratch/
  drafts/
  index.md
```

Shared bundle:

```text
knowledge-shared/
  decisions/
  systems/
  runbooks/
  concepts/
  people/
  index.md
```

Git repository permissions are the access-control layer. The MCP server only reads local directories that the user has already mounted or cloned.

## Frontmatter

Required:

- `type`

Recommended:

- `title`
- `description`
- `tags`
- `timestamp`

Shared bundle types:

- `system`
- `decision`
- `runbook`
- `concept`
- `person`
- `index`

## Links

Use normal relative Markdown links as the primary convention:

```markdown
See [API Gateway](../systems/api-gateway.md).
```

The tools also tolerate wiki links:

```markdown
See [[systems/api-gateway]].
```

Use explicit bundle prefixes only when ambiguity matters:

```markdown
See [[shared:systems/api-gateway]].
```

During promotion, explicit `personal:` links are rewritten to shared-local links where possible.

## Promotion Review

Promotions from personal to shared knowledge should answer:

- Is this safe for the team repo?
- Does it include private notes, customer data, or credentials?
- Are links valid from the shared bundle?
- Is the `type` one of the shared conventions?
- Does the title make sense outside the author's personal context?

## PR Template

```markdown
## Summary

- Promotes:
- Why this belongs in shared knowledge:

## Checks

- [ ] No private notes or credentials
- [ ] Links resolve from the shared bundle
- [ ] `type` matches shared conventions
- [ ] `index.md` updated
```
