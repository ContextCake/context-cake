# Secret rotation

Every long-lived secret the project holds, who owns it, and what to do when it
expires or leaks. A secret with no named owner and no cadence is a secret
nobody rotates.

Nothing here lives in the repository. If you find any of these values committed,
treat it as a leak and follow the last section.

## Inventory

| Secret | Used for | Where it lives | Cadence |
|---|---|---|---|
| Apple Developer ID certificate + key | Signing and notarizing the Mac app | Apple Developer account; CI secret | Expires ~5 years; renew a month early |
| App-specific password / notarytool key | Notarization in CI | CI secret | On staff change or leak |
| `SUPABASE_URL` + anon key | Accounts builds only (`CC_ACCOUNTS=1`) | CI secret; not in shipped builds | On leak |
| Apple Sign in with Apple key (`.p8`) + client secret JWT | Apple sign-in, when it ships | Apple Developer account; Supabase dashboard | **JWT expires within 6 months — hard deadline** |
| Google OAuth client secret | Google sign-in, when it ships | Google Cloud console; Supabase dashboard | On leak |
| GitHub App private key | Brokered org repo access, when it ships | Wherever the broker runs | Annually, and on any staff change |

The Apple JWT is the one that bites. Apple caps the client secret at six months,
so sign-in breaks on a date rather than on an event. Put the expiry in a
calendar the day it is created.

The GitHub App private key is the most dangerous entry. It mints tokens for
every organization that installed the app, so a leak is not one customer's
problem.

## Signing identity

The signing key is the highest-value secret here and does not behave like the
others. A leaked API token reads some repositories; a leaked signing identity
lets someone hand our users software that says it is ours, through an updater
that installs automatically.

Rules:

- Only the release workflow signs. No signing from a laptop.
- Restrict who can publish a GitHub Release; publishing is equivalent to
  shipping code to every install.
- On suspicion of compromise: revoke the certificate with Apple first, then
  rotate, then re-sign. Users on the old build keep working; the concern is what
  ships next.

## Rotating an OAuth or API secret

1. Create the new value at the provider. Do not delete the old one yet.
2. Update the CI secret, or the provider dashboard, or both.
3. Ship or redeploy whatever reads it.
4. Verify the flow end to end — sign in, or add a source.
5. Only then revoke the old value.

Deleting first turns a routine rotation into an outage.

## If something leaks

In this order:

1. **Revoke at the provider.** Rotation without revocation leaves the leaked
   value working.
2. **Assume use.** Check the provider's audit log for what the credential did
   before you noticed.
3. **Rotate**, per the steps above.
4. **Purge where it leaked.** A committed secret stays in git history; rewriting
   history does not un-publish it if the repository is public. Revocation is
   what fixes it.
5. **Tell whoever is affected.** For the GitHub App key that means every
   organization with the app installed.
6. **Write down how it got out**, and add the check that would have caught it.

For a vulnerability reported by someone else, see
[SECURITY.md](../../SECURITY.md).

## Related

- [Threat model](./threat-model.md) — what these secrets protect
- [Egress allowlist](./egress-allowlist.md) — where credentials are sent
