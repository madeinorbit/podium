/** Measurement-only build: production components, source maps, ordinary React. */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwindcss from '../node_modules/@tailwindcss/vite/dist/index.mjs'
import { defineConfig } from '../node_modules/vite/dist/node/index.js'

const repo = process.cwd()
export default defineConfig({
  root: resolve(repo, 'apps/web'),
  cacheDir: resolve(repo, 'node_modules/.cache/sidebar-acceptance'),
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
      allow: [repo, ...['geist', 'geist-mono'].map(font =>
        realpathSync(resolve(repo, 'apps/web/node_modules/@fontsource-variable', font)))],
    },
  },
  build: {
    outDir: resolve(repo, '.artifacts/sidebar-acceptance/build'),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    target: 'es2022',
    rollupOptions: { input: resolve(repo, 'apps/web/test/sidebar-acceptance.browser.html') },
  },
})
