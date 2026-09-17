// `account status` (control-plane spec §5.1, §8.6). Accounts, OAuth, and
// deletion belong to the signed Mac app; builds ship with accounts disabled,
// so the CLI reports that as a typed state and exits 0 rather than leaving
// agents to guess from a missing command.

import { defineFamily } from "../table.mjs";

export default defineFamily({
  name: "account",
  stability: "stable",
  summary: "report account state (accounts are disabled in this build)",
  commands: [
    {
      name: "status",
      summary: "report whether accounts are available in this build",
      mutation: "read",
      output: {
        type: "object",
        required: ["state", "reason", "message"],
        properties: {
          state: { enum: ["disabled"] },
          reason: { enum: ["disabled-in-build"] },
          message: { type: "string" },
        },
      },
      run() {
        const data = {
          state: "disabled",
          reason: "disabled-in-build",
          message: "Accounts are disabled in this build. Everything else works without one.",
        };
        return { data, text: data.message };
      },
    },
  ],
});
