/** POD-5133 measurement-only build: the POD-4959 production settings (source
 * maps, no minification, ordinary React) without its timing boundaries, so
 * constructor and closure names survive into heap snapshots. */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwindcss from '../node_modules/@tailwindcss/vite/dist/index.mjs'
import { defineConfig } from '../node_modules/vite/dist/node/index.js'

const repo = process.cwd()
export default defineConfig({
  root: resolve(repo, 'apps/web'),
  cacheDir: resolve(repo, 'node_modules/.cache/pool-memory'),
  plugins: [tailwindcss()],
  resolve: {
    conditions: ['@podium/source'],
    dedupe: ['react', 'react-dom'],
    alias: { '@': resolve(repo, 'apps/web/src') },
  },
  esbuild: { jsx: 'automatic' },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    hmr: false,
    fs: {
      allow: [
        repo,
        ...['geist', 'geist-mono'].map((font) =>
          realpathSync(resolve(repo, 'apps/web/node_modules/@fontsource-variable', font)),
        ),
      ],
    },
  },
  build: {
    outDir: resolve(repo, '.artifacts/pool-memory/build'),
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    target: 'es2022',
    rollupOptions: { input: resolve(repo, 'apps/web/test/pool-memory.browser.html') },
  },
})
