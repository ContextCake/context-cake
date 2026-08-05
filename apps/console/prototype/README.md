# Mac-first UI visual gate

This dependency-free prototype is the visual gate for the ContextCake desktop
UI modernization. It uses fixed fixtures and makes no engine or network calls.

Open `mac-first-ui.html` directly, or serve this directory with any static HTTP
server. The control bar switches viewport, appearance, density, and account
state. The shell also implements the proposed keyboard contract:

- `Command-K`: command palette
- `Command-1` through `Command-5`: primary destinations
- `Command-F`: contextual search
- `Command-Shift-A`: Ask ContextCake
- `Command-,`: Settings

Named screenshot states are available through the `shot` query parameter:

- `home-light`
- `home-dark`
- `knowledge-compact`
- `review-narrow`
- `settings-general`
- `settings-account-pending`
- `palette`

For example: `mac-first-ui.html?shot=settings-account-pending`.

The prototype is deliberately isolated from the production React entrypoint.
It must not be merged as production application code.
