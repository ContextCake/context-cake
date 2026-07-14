# ContextCake Accounts & Authentication — Spec

**Date:** 2026-07-14
**Status:** Approved (decisions locked with John, 2026-07-14)
**Workflow:** Requirements-First (desired behavior known; provider integration flexible)
**Provider decision:** Supabase (hosted OAuth + Postgres settings store) — chosen over WorkOS/Clerk for zero-backend settings sync; revisit if enterprise SSO demand materializes
**Depends on:** `specs/contextcake-distribution/design.md` (deep link, safeStorage, process model)

---

## 1. Problem statement

ContextCake has no identity: preferences and configuration live on one machine
and die with it, there is nothing to attach future entitlements (packs, pro
features, team spaces) to, and "sign in" is table stakes for a product that
asks users to trust it near company context. The bar is **industry-standard
OAuth** — no homegrown password store, no embedded login forms.

## 2. Goals

- Sign in with **GitHub or Google** via the **system browser** using OAuth 2.0
  authorization code + **PKCE** (public client; no client secret in the app).
- **Local-first is preserved:** a signed-out user has full local
  functionality. Accounts add sync + entitlements; they gate nothing local.
- **Settings sync** across machines: preferences + profile/source definitions.
- A trust posture we can publish: context content and integration tokens
  **never** reach our servers.

## 3. Non-goals (v1)

Payments/entitlements enforcement (hooks only) · team/shared spaces · SAML SSO
(future: Supabase SSO add-on or WorkOS in front) · web-console sign-in (web
stays demo-only) · email/password auth (never, see §7).

## 4. User stories

- **Dana** signs in with GitHub on her work Mac; on a new laptop her profiles
  and preferences arrive after sign-in — but every integration re-authenticates
  locally, because tokens never synced.
- **Theo** refuses accounts entirely; everything except sync works, forever.
- **A departing user** deletes their account from Settings and all server-side
  data is gone, no support ticket.

## 5. Acceptance criteria (EARS)

### Sign-in flow
- [ ] WHEN the user initiates sign-in THE SYSTEM SHALL open the provider's
  hosted OAuth page in the **system browser** (never an embedded webview) and
  complete OAuth 2.0 authorization-code + PKCE as a public client.
- [ ] WHEN the provider redirects THE SYSTEM SHALL receive the callback on the
  registered `contextcake://auth/callback` deep link and perform the code
  exchange **in the main process**; the renderer SHALL never handle raw tokens.
- [ ] WHEN sign-in succeeds THE SYSTEM SHALL persist the session encrypted via
  the OS-keychain-backed store (`safeStorage`); plaintext tokens SHALL never be
  written to disk or logs.
- [ ] WHEN the stored session expires THE SYSTEM SHALL refresh it silently and
  SHALL degrade to signed-out (with a non-blocking notice) if refresh fails.

### Local-first guarantee
- [ ] WHEN the app runs signed-out THE SYSTEM SHALL provide full local
  functionality (resolve, MCP serving, sources, profiles) with no nagging
  beyond a single passive sign-in affordance.
- [ ] WHEN the auth provider is unreachable THE SYSTEM SHALL start normally in
  signed-out mode; auth outages SHALL never block local use.

### Settings sync
- [ ] WHEN settings sync uploads THE SYSTEM SHALL send only: UI preferences,
  profile definitions, and source configurations **with every secret and every
  machine-identifying absolute path scrubbed** — and SHALL reject (not scrub
  silently) any blob found to contain a credential pattern.
- [ ] WHEN any sync payload is prepared THE SYSTEM SHALL exclude context
  content and integration tokens categorically — these never leave the device.
- [ ] WHEN the same account writes from two machines THE SYSTEM SHALL apply
  last-write-wins by server timestamp (v1) and surface the overwrite in the UI.

### Account lifecycle & privacy
- [ ] WHEN the user deletes their account THE SYSTEM SHALL self-serve delete
  all server-side rows (auth user + settings) and return the app to signed-out.
- [ ] WHEN auth or sync traffic flows THE SYSTEM SHALL use HTTPS to the
  provider host only, carrying no analytics or telemetry.
- [ ] WHEN the docs describe accounts THE SYSTEM SHALL publish exactly what is
  stored server-side (account email + settings blob) and what never is
  (context, tokens, paths).

## 6. Data model (Supabase)

- `auth.users` — managed by Supabase (email from OAuth provider).
- `public.user_settings` — `user_id uuid PK references auth.users on delete
  cascade`, `blob jsonb`, `updated_at timestamptz`. RLS: owner-only
  select/insert/update/delete. No other tables in v1.

## 7. Boundaries

- ✅ **Always:** system browser + PKCE; tokens via `safeStorage`; RLS on every
  table; signed-out mode fully functional; scrub-then-verify before sync.
- ⚠️ **Ask first:** adding an auth provider beyond GitHub/Google; storing any
  server-side field beyond email + settings blob; any scope expansion; moving
  off Supabase.
- 🚫 **Never:** email/password or any custom credential store; integration
  tokens or context content server-side; secrets in the repository; absolute
  paths or PII in the synced blob (John's global PII rule); auth in the web
  demo console.

## 8. For the implementing agent

- **Commands:** `cd apps/desktop && npm run dev` (auth flows testable with a
  dev Supabase project; `SUPABASE_URL`/`SUPABASE_ANON_KEY` via env in dev).
  The anon key is public-by-design; RLS is the security boundary.
- **Structure:** auth broker + storage adapter live in `apps/desktop/src/main/`
  (e.g. `auth.mjs`, `settings-sync.mjs`); renderer gets state via preload
  events only. Console UI: Settings view (sign-in/out, sync status, delete
  account) in `apps/console/src/views/`.
- **Testing:** unit-test the scrubber (path/credential patterns) and the
  storage adapter round-trip in `apps/console`/`apps/desktop` vitest; flow
  smoke-tested manually per the verification list below. Engine (`npm test`)
  untouched by this feature.
- **Code style:** desktop main process is ESM `.mjs` matching the engine's
  voice; renderer follows console TS conventions.
- **Git:** conventional commits; branch per feature.
- **Verification:** sign in → session present in Keychain (Keychain Access),
  nothing plaintext under Application Support; settings round-trip from a
  second macOS user account; delete account → rows gone; grep sync payload for
  `/Users/` and token patterns in a test.
- **Self-verification:** compare implementation against §5 and list any
  criteria not addressed.
