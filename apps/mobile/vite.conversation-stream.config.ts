import { resolve } from 'node:path'
import { mergeConfig } from 'vite'
import inbox from './vite.inbox.config'
import { conversationRenderMeter } from '../web/harness/conversation-render-meter'

export default async () => mergeConfig(await inbox(), {
  define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' },
  plugins: [conversationRenderMeter('phone')],
  build: { minify: true, rollupOptions: { input: resolve(import.meta.dirname, 'test/conversation-stream.browser.html') } },
})
