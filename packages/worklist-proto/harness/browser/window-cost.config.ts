/** Isolated browser cache probe: no extra entry in any arm's measured bundle. */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import base from '../web/vite.config'

export default defineConfig({
  ...base,
  root: fileURLToPath(new URL('.', import.meta.url)),
  build: {
    ...base.build,
    outDir: 'dist-window-cost',
    rollupOptions: { input: fileURLToPath(new URL('./window-cost.html', import.meta.url)) },
  },
})
