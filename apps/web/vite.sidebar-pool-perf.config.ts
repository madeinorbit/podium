import { standardDecorators } from '../../scripts/vite-standard-decorators'
import { productWorkMeter } from '../../tests/worklist/harness/src/perf/vite'
/** The real pool attachment with synthetic data and no live backend. */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const fontRoots = ['geist', 'geist-mono'].map((font) =>
  realpathSync(`${root}/node_modules/@fontsource-variable/${font}`),
)
export default defineConfig({
  root,
  cacheDir: `${root}/node_modules/.cache/sidebar-pool-perf-vite`,
  plugins: [standardDecorators(), tailwindcss(), productWorkMeter()],
  optimizeDeps: {
    entries: [
      'test/store-worklist-pool.browser.html',
      'test/sidebar-renderer.browser.html',
    ],
  },
  resolve: {
    conditions: ['@podium/source'],
    dedupe: ['react', 'react-dom'],
    alias: { '@': `${root}/src` },
  },
  esbuild: { jsx: 'automatic' },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    hmr: false,
    fs: { allow: [repoRoot, ...fontRoots] },
  },
})
