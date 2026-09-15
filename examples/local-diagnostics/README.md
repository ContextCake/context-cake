# Local diagnostics walkthrough

Run from the repository root with Node 22+. This creates and removes only a
private temporary two-document fixture:

```bash
node examples/local-diagnostics/run.mjs
```

To also send these real engine observations to an already enabled Local Grafana:

```bash
node examples/local-diagnostics/run.mjs --telemetry-config "$HOME/Library/Application Support/ContextCake/local-observability.json"
```

The walkthrough searches, edits one document, verifies one read/one reuse, makes
its temporary source unavailable, checks the native warning, restores it, and
verifies recovery. The JSON report contains the observation trace IDs. In Grafana,
filter Events and traces to `index: error` or `coverage: partial`; open the trace
from that event. No user knowledge folder is changed.

For an interactive Mac check, add a **copy** of `apps/playground/demo-layers` to an
isolated app profile, search it, open Diagnostics, then rename one of the copied
source folders. Use Sources → reindex if needed. Observe the warning, restore the
folder, and verify recovery. The public Web Demo never runs this walkthrough.
