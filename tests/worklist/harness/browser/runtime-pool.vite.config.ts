import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const appRoot = fileURLToPath(new URL('../../../../apps/web/', import.meta.url))

/** Only synthetic data and the product StoreProvider/attachment. Build outside
 * the Vitest worker; the browser test serves these bytes without a dev server. */
export default defineConfig({
  root: appRoot,
  resolve: {
    conditions: ['@podium/source'], dedupe: ['react', 'react-dom'],
    alias: { '@': `${appRoot}/src` },
  },
  esbuild: { jsx: 'automatic' },
  define: { 'import.meta.env.DEV': 'true' },
  build: {
    outDir: fileURLToPath(new URL('../../node_modules/.cache/runtime-pool-browser/', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: { input: `${appRoot}/test/store-worklist-pool.browser.html` },
  },
})
