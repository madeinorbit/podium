/** The real pool attachment and panel, with synthetic data and no live backend. */
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))
export default defineConfig({
  root,
  plugins: [tailwindcss()],
  resolve: {
    conditions: ['@podium/source'],
    dedupe: ['react', 'react-dom'],
    alias: { '@': `${root}/src` },
  },
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', strictPort: true },
})
