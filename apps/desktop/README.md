# ContextCake for Mac

The desktop shell: the dependency-free engine (`packages/core`) runs in the
Electron main process behind a loopback HTTP service with a per-launch bearer
token, and the console (`apps/console`) is the renderer, served at
`/console/` so its live mode engages unchanged. Spec:
`specs/contextcake-distribution/spec.md` + `design.md`, and
`specs/contextcake-auth/spec.md` for optional accounts.

## Commands

```bash
cd apps/desktop
npm ci
npm run renderer   # build the console renderer (needed after console changes)
npm run start      # launch the app (dev, expects a prior renderer build)
npm run dev        # renderer + start
npm test           # auth storage + settings-sync security tests
npm run smoke      # boot headlessly, verify the token-guarded service, exit
npm run pack       # unpacked .app in dist/ (ad-hoc signed)
npm run dist       # DMG + zip in dist/ (ad-hoc signed until release secrets exist)
```

## Layout

| Path | Role |
|---|---|
| `src/main/main.mjs` | App lifecycle, window, deep-link hook (`contextcake://`) |
| `src/main/service-host.mjs` | Boots `packages/core/src/service.mjs` on 127.0.0.1 with a bearer token |
| `src/main/auth.mjs` | Main-process OAuth broker, PKCE callback, encrypted session lifecycle |
| `src/main/settings-sync.mjs` | Owner-scoped settings sync with path/secret scrub-and-reject checks |
| `src/main/updater.mjs` | electron-updater against GitHub Releases (`app-v*`), settings-gated |
| `src/main/cli-install.mjs` | Symlinks the CLI shim into `/usr/local/bin` |
| `src/preload.cjs` | Sandboxed bridges: launch metadata in `window.__CC_DESKTOP`; auth/settings IPC in `window.__CC_AUTH` |
| `src/cli/cli.mjs` | `contextcake` dispatcher over the bundled engine entrypoints |
| `resources/bin/contextcake` | Shell shim installed for the CLI |
| `electron-builder.yml` | Packaging: DMG/zip, arm64, hardened runtime, protocols |

## User data (never touched by updates)

- Config: `~/Library/Application Support/ContextCake/` (`manifest.json`, `settings.json`)
- Caches: `~/Library/Caches/ContextCake/`
- Account session: persisted as encrypted `session.enc` only when Keychain-backed
  `safeStorage` is available; otherwise it remains memory-only for that run
- Supabase project config: optional `supabase.json` (`url` + public `anonKey`), or
  `SUPABASE_URL` / `SUPABASE_ANON_KEY` in development

Accounts are optional. Supabase Auth stores managed user, provider-identity, session,
refresh-token, and audit-log records (including provider-supplied profile metadata and
request metadata such as timestamps, IP address, and user agent), plus one owner-only
settings row. Synced settings contain preferences, profiles, and source metadata after absolute
paths, executable MCP commands/arguments, cache directories, and secret references are
scrubbed. Context content, integration tokens, raw environment values, local paths, and
remote-activatable commands are never uploaded. Integrations are configured locally on
each Mac. Deleting an account removes the Auth user and synced row while leaving local
files untouched. Supabase-managed operational and audit logs follow the project's
configured retention and are not necessarily removed with the account.

## Supabase account setup

1. Install the Supabase CLI and Docker, then authenticate. From the repository root,
   generate a migration from `supabase/schemas/user_settings.sql` and test the complete
   migration history locally:

   ```bash
   supabase login
   supabase start
   supabase db diff -f user_settings
   supabase db reset
   supabase db lint --level warning
   ```

   Review and commit the generated file under `supabase/migrations/`. Declarative diffs
   may omit schema/table/function privileges, so compare its `grant` and `revoke`
   statements with the schema before deployment. Then link and deploy deliberately:

   ```bash
   supabase link --project-ref <project-ref>
   supabase db push --dry-run
   supabase db push
   ```
   Run the Database advisors in the Dashboard after deploying.
2. Create GitHub and Google OAuth applications, using Supabase's provider callback
   `https://<project-ref>.supabase.co/auth/v1/callback`, then add their client
   credentials under **Authentication → Providers**.
3. Add `contextcake://auth/callback` to **Authentication → URL Configuration →
   Redirect URLs**.
4. For local UI development, export `SUPABASE_URL` and `SUPABASE_ANON_KEY`, then run
   `npm run dev`. Browser OAuth cannot return to the unpackaged dev process because
   macOS registers the custom protocol for packaged apps only. Test the full sign-in
   callback with `npm run pack`, then launch the generated `.app`. The key must be
   `sb_publishable_*` or a legacy `anon` JWT; the build rejects privileged keys.
5. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as GitHub Actions secrets
   before packaging a release.

## Release

`app-v*` tags drive the release workflow (signing + notarization + GitHub
Release with `latest-mac.yml` and `SHA256SUMS`). Requires the Apple Developer
secrets described in `specs/contextcake-distribution/design.md` §8. Until
those exist, `npm run dist` produces ad-hoc-signed artifacts for local testing
only — they must not be distributed.
Packaged account builds require `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` (the `SUPABASE_*` aliases also work). The packaging
scripts generate `build/supabase-config.json` and electron-builder copies that
public project configuration into the app resources; the generated file is
gitignored.
