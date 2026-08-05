import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import desktopPackage from '../desktop/package.json' with { type: 'json' }

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
  // The renderer has no independent product version. Both the hosted Web Demo
  // and packaged app identify with the coordinated desktop release version.
  define: { __APP_VERSION__: JSON.stringify(desktopPackage.version) },
})
