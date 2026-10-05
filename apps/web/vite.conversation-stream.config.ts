import { resolve } from 'node:path'
import { defineConfig, mergeConfig } from 'vite'
import base from './vite.sidebar-pool-perf.config'
import { conversationRenderMeter } from './harness/conversation-render-meter'

export default defineConfig(mergeConfig(base, {
  plugins: [conversationRenderMeter('web')],
  build: { minify: true, rollupOptions: { input: resolve(import.meta.dirname, 'test/conversation-stream.browser.html') } },
}))
