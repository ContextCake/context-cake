# ContextCake Distribution Channels and Privacy-Preserving Acquisition Metrics

ContextCake will offer supported developer and desktop installation channels alongside the signed Mac app: Homebrew, a Claude Desktop MCP bundle, and npm/npx. Every public channel will carry a consistent release identity and contribute only the minimum useful adoption signal.

## Problem Statement

The signed Mac app is presently the only packaged installation path. Developers who use Homebrew, npm/npx, or Claude Desktop's MCP bundle workflow cannot use a first-class ContextCake distribution route, and the maintainer cannot see one coherent picture of channel adoption. Download counts alone are not people, and collecting hidden identifiers or user context would conflict with ContextCake's local-first trust posture.

## User Stories

- As a Mac developer, I can install ContextCake through Homebrew and understand that normal package-manager upgrades remain in charge of the installed files.
- As a Claude Desktop user, I can install one verified ContextCake MCP bundle without manually reconstructing a local server command.
- As a terminal-first developer, I can run or install ContextCake through npm/npx from an authenticated, auditable public package.
- As a prospective user, I can download without creating an account, and can explicitly opt in if I want to identify myself or receive updates.
- As a maintainer, I can compare aggregate acquisition and activation by channel, version, and campaign without treating downloads as unique people or receiving user knowledge, prompts, local paths, tokens, or a covert device identifier.

## Acceptance Criteria

- [ ] Homebrew, MCP bundle, and npm/npx are each documented only once their corresponding install artifact is published and independently verified.
- [ ] A coordinated Homebrew and npm release identifies the same ContextCake version and provides safe channel-appropriate upgrade guidance.
- [ ] The MCP bundle is versioned, integrity-verifiable, and declares the same ContextCake release identity as the source and desktop channels.
- [ ] Every published channel has an aggregate acquisition signal that distinguishes channel, release version, and optional campaign/referrer without requiring an account.
- [ ] The desktop app and MCP bundle each provide a content-free, privacy-disclosed activation signal after a successful first use; repeated starts do not inflate first-use counts.
- [ ] Download and activation reporting explicitly distinguishes events from estimated people and documents each known counting limitation.
- [ ] An identity signal is collected only after an explicit, optional user opt-in. Downloading, installing, updating, and local use work without it.
- [ ] No acquisition or activation event includes knowledge content, prompts, source paths, manifest data, credentials, stable device fingerprints, or a user identifier unless the user deliberately supplies contact information through the opt-in flow.
- [ ] The public site presents one clearly recommended route for the visitor's context and shows other supported channels as alternatives, not as placeholders or equal-weight calls to action.
- [ ] Release publication fails closed if a channel's artifact, integrity record, or required aggregate metric mapping is missing.

## Out of Scope

- Requiring an account, email address, or analytics consent to download or use ContextCake.
- Behavioral advertising, cross-site tracking, fingerprinting, sale of analytics data, or uploading local knowledge for acquisition analytics.
- Native installers for Intel Macs, Windows, or Linux.
- Enterprise fleet/MDM distribution and per-seat reporting.
- Automated marketing campaigns beyond recording a voluntary opt-in.

## Open Questions

None. External registry, Homebrew tap, and optional-contact-service credentials are release dependencies; they do not alter the privacy or channel contract above.

## Dependencies

- A verified public Homebrew tap with a maintained ContextCake cask.
- An npm account with two-factor authentication and a repository-bound trusted-publishing configuration.
- An MCP registry publisher identity and a release-hosted MCP bundle artifact.
- A privacy-reviewed optional-contact service for people who deliberately identify themselves.
- The existing GitHub Releases metrics snapshot and first-launch measurement, expanded to a channel-level report.
