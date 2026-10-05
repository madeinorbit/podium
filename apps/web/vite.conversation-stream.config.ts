import { resolve } from 'node:path'
import { defineConfig, mergeConfig } from 'vite'
import base from './vite.sidebar-pool-perf.config'

export default defineConfig(mergeConfig(base, {
  build: { minify: true, rollupOptions: { input: resolve(import.meta.dirname, 'test/conversation-stream.browser.html') } },
}))
