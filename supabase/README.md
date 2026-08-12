# Supabase project

Owned by [`apps/desktop/`](../apps/desktop). Nothing in the engine
(`packages/core/`) talks to Supabase — the dependency-free rule still holds.
This lives at the repo root because the Supabase CLI expects `supabase/`
beside the directory it is run from, not because the project has a backend
tier of its own.

What it backs: signed-in Mac app users get their settings synced across
machines. `user_settings` is the only table.

| Path | Role |
|------|------|
| `config.toml` | Local Supabase CLI project config |
| `schemas/` | Declarative schema — the source of truth you edit |
| `migrations/` | Generated from `schemas/` via `supabase db diff`; never hand-edit |

Changing the schema is documented in
[`apps/desktop/README.md`](../apps/desktop/README.md) — read the note there
about declarative diffs omitting privileges before you generate a migration.
