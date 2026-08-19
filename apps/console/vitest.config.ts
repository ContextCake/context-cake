import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Test-only config, separate from vite.config.ts (which drives dev/build).
// Tests opt into jsdom per-file with `// @vitest-environment jsdom` since
// only api.test.ts and update.test.ts need `window`/`location`.
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify('0.0.0-test') },
  test: {
    environment: 'node',
    // Vitest blanks every `.css` import — including `styles.css?raw` — unless
    // its id is listed here. The theme gates (theme.test.ts, themes/*.test.ts)
    // read the stylesheet as text through that raw import so they need no
    // node:fs / @types/node; ordinary CSS imports stay empty.
    css: { include: [/\.css\?raw$/] },
  },
})
