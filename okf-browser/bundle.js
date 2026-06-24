window.BUNDLE_NAME = "team-context";
window.BUNDLE = {
  nodes: [
    {
      data: {
        id: "systems/billing-api/payment-webhooks",
        label: "Payment webhook handling",
        type: "system",
        description: "How the billing API processes inbound payment webhooks and retries failures.",
        resource: "../control-surface/index.html",
        tags: ["billing", "payments", "webhooks"],
        color: "#2f8b57",
        size: 70
      }
    },
    {
      data: {
        id: "runbooks/payment-webhook-retries",
        label: "Webhook retry runbook",
        type: "runbook",
        description: "Operational steps for retrying failed payment webhook deliveries after an incident.",
        resource: "../control-surface/index.html",
        tags: ["incident", "runbook", "payments"],
        color: "#d08a15",
        size: 50
      }
    },
    {
      data: {
        id: "interfaces/jwt-audience-contract",
        label: "JWT audience contract",
        type: "interface",
        description: "Shared contract for JWT audience validation used by internal clients.",
        resource: "../control-surface/index.html",
        tags: ["auth", "contract", "identity"],
        color: "#416fd7",
        size: 52
      }
    },
    {
      data: {
        id: "systems/web-app/feature-flags",
        label: "Feature flag evaluation",
        type: "system",
        description: "Where feature flags are resolved in the web application and how they map to release behavior.",
        resource: "../control-surface/index.html",
        tags: ["frontend", "flags", "onboarding"],
        color: "#2f8b57",
        size: 48
      }
    },
    {
      data: {
        id: "decisions/deprecate-legacy-export-job",
        label: "Deprecate legacy export job",
        type: "decision",
        description: "Decision record for retiring the old data export path after migration.",
        resource: "../control-surface/index.html",
        tags: ["data", "migration", "deprecation"],
        color: "#775ce6",
        size: 46
      }
    },
    {
      data: {
        id: "systems/identity-service/token-issuance",
        label: "Token issuance flow",
        type: "system",
        description: "Identity-service flow for minting and validating internal tokens.",
        resource: "../control-surface/index.html",
        tags: ["auth", "identity", "tokens"],
        color: "#2f8b57",
        size: 44
      }
    }
  ],
  edges: [
    { data: { id: "e1", source: "systems/billing-api/payment-webhooks", target: "runbooks/payment-webhook-retries" } },
    { data: { id: "e2", source: "systems/billing-api/payment-webhooks", target: "interfaces/jwt-audience-contract" } },
    { data: { id: "e3", source: "systems/identity-service/token-issuance", target: "interfaces/jwt-audience-contract" } },
    { data: { id: "e4", source: "systems/web-app/feature-flags", target: "decisions/deprecate-legacy-export-job" } },
    { data: { id: "e5", source: "systems/web-app/feature-flags", target: "interfaces/jwt-audience-contract" } }
  ],
  bodies: {
    "systems/billing-api/payment-webhooks": `# Overview
The billing API receives payment provider webhook deliveries, validates the signature, maps provider event types into internal actions, and writes an idempotent processing record.

## Why it matters
- Webhook failures create customer-visible billing drift.
- Retry policy belongs in a runbook, but handler ownership belongs in the system note.

## Linked context
- [Webhook retry runbook](/runbooks/payment-webhook-retries.md)
- [JWT audience contract](/interfaces/jwt-audience-contract.md)
`,
    "runbooks/payment-webhook-retries": `# Purpose
This runbook exists for failed or delayed webhook deliveries after an incident.

## Steps
1. Confirm whether the event failed signature validation or downstream processing.
2. Replay only idempotent-safe events.
3. Check the billing ledger for duplicate writes before replay.

## Escalation
Escalate to the billing owner if replay would mutate previously reconciled orders.
`,
    "interfaces/jwt-audience-contract": `# Contract
Internal clients must present tokens with the correct audience for each service boundary.

## Review triggers
- new internal client
- audience rename
- token validation logic change

## Related systems
- [Token issuance flow](/systems/identity-service/token-issuance.md)
- [Payment webhook handling](/systems/billing-api/payment-webhooks.md)
`,
    "systems/web-app/feature-flags": `# Overview
Feature flags are evaluated in the web app at request time and cached per user session.

## Use cases
- release gating
- operational kill switches
- onboarding defaults

## Related decision
- [Deprecate legacy export job](/decisions/deprecate-legacy-export-job.md)
`,
    "decisions/deprecate-legacy-export-job": `# Decision
Retire the legacy export path after migration traffic remains stable for two release windows.

## Consequences
- simplify pipeline ownership
- reduce dual-write risk
- remove obsolete support paths
`,
    "systems/identity-service/token-issuance": `# Overview
The identity service mints internal access tokens and enforces token audience mapping.

## Dependency
- [JWT audience contract](/interfaces/jwt-audience-contract.md)
`
  },
  types: ["system", "runbook", "interface", "decision"],
  palette: {
    system: "#2f8b57",
    runbook: "#d08a15",
    interface: "#416fd7",
    decision: "#775ce6"
  }
};
