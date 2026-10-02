/** Production React/MobX, unminified for allocation-site attribution. */
import { resolve } from 'node:path'
import { defineConfig } from '../node_modules/vite/dist/node/index.js'

export default defineConfig({
  root: resolve('apps/web'),
  cacheDir: resolve('node_modules/.cache/pool-build-cost'),
  resolve: { conditions: ['@podium/source'], dedupe: ['react', 'react-dom'], alias: { '@': resolve('apps/web/src') } },
  esbuild: { jsx: 'automatic' },
  build: {
    outDir: resolve('.artifacts/pool-build-cost/build'), emptyOutDir: true,
    sourcemap: true, minify: false, target: 'es2022',
    rollupOptions: { input: resolve('apps/web/test/pool-build-cost.browser.html') },
  },
})
