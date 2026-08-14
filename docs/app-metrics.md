# Distribution and activation metrics

ContextCake uses a small set of anonymous, aggregate metrics to understand
whether people can download and successfully open the app. We use these counts
to improve installation, onboarding, and release quality.

There is no analytics SDK or ContextCake-operated behavioral-tracking service.
GitHub Releases is the source of truth for direct artifacts; npm and Homebrew
provide their own public aggregate reports when those channels are live.

Run the current report from the repository root:

```bash
npm run metrics:app
```

Add `-- --json` for machine-readable output. The `App Metrics Snapshot` GitHub
Actions workflow also records a weekly job summary and retains a JSON snapshot
for 90 days.

## What we collect

| Metric | Source | Interpretation |
|---|---|---|
| DMG downloads | GitHub `*.dmg` asset `download_count` | Direct installer downloads. Repeat downloads count again. |
| ZIP/update downloads | GitHub `*.zip` asset `download_count` | ZIP downloads, including native updater traffic. Not a unique-person count. |
| MCPB downloads | GitHub `*.mcpb` asset `download_count` | Claude Desktop bundle downloads. Repeat downloads count again. |
| Confirmed first launches | GitHub `install-ping.txt` asset `download_count` | One successful packaged-app launch per persistent ContextCake data directory after tracking shipped. The app version is part of the release URL. |
| Confirmed MCPB activations | GitHub `mcpb-install-ping.txt` asset `download_count` | One successful MCPB server start per local marker, only after the bundle's explicit opt-in is enabled. |
| npm downloads | npm public download API | Per-package-version downloads over npm's reported window. This is not a person count. |
| Homebrew installs | Homebrew public 30-day cask aggregate | Anonymous cask installs when the cask appears in Homebrew's public report. It may be absent for a new or unsupported tap. |

## What we never collect

Anonymous usage metrics never include files or knowledge content, file names or
paths, prompts, resolved answers, account details, an email address, a device
ID, or a persistent remote identifier. The request has no event body and
ContextCake does not set a cookie. GitHub receives the ordinary request metadata
it already receives for app downloads and update checks, including the network
address used to connect; see [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

## Your choice

The packaged app asks before it shares its first anonymous metric. Choosing
**Don't Share** sends nothing. You can change the choice at any time under
**Settings → General → Anonymous usage metrics** or with **Share Anonymous Usage
Metrics** in the ContextCake application menu.

This preference is local to the Mac's ContextCake application-support directory.
It is not included in account settings sync, so a choice made on another Mac
cannot enable metrics without the local first-run choice.

Turning the setting off stops an unreported first launch, retries after a failed
request, and any future anonymous metrics. An aggregate count already recorded
cannot be removed because ContextCake has no identifier that could connect that
count back to a person or device.

After an allowed first launch, the app downloads the release's tiny
`install-ping.txt` asset once and writes `install-metric-v1.json` in
ContextCake's application-support directory so it does not report again.

A failed request does not affect startup and may be retried on a later launch
only while anonymous metrics remain enabled. Update checks and anonymous metrics
are separate settings.

These are directional product metrics, not billing or unique-user records. A
fresh application-support directory can count again, public release assets can
be downloaded outside the app, and older releases without `install-ping.txt`
cannot report first launches. The first release that includes the counter will
also count existing users when they update and launch it, so that release is an
installed-base baseline rather than a new-install cohort.

## MCPB and package-manager channels

The Claude Desktop `.mcpb` bundle presents a separate **Share anonymous
activation metrics** choice. It defaults to off. If enabled, a successfully
started server downloads the release's tiny `mcpb-install-ping.txt` file once
per local marker. The request contains no ContextCake manifest, local path,
tool input, knowledge content, prompt, or account identifier.

The npm CLI has no install-time or runtime telemetry. npm counts registry
downloads independently. Homebrew likewise owns its optional anonymous
analytics; ContextCake does not add a second request to a `brew install`.

We cannot tell who an anonymous channel count belongs to, and we do not try to
infer it. A person who wants release notes or product updates can choose a
separate contact/updates registration once it is launched; that opt-in will
store only the submitted contact information and consent timestamp, never be
joined to anonymous download or activation events. Until that service is live,
the product does not request an email address.
