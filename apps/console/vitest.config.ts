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
  },
})
