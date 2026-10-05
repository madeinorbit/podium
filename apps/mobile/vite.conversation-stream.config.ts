import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import inbox from './vite.inbox.config'
import { conversationRenderMeter } from '../web/harness/conversation-render-meter'

const webRequire = createRequire(new URL('../web/package.json', import.meta.url))
export default async () => {
  const { mergeConfig } = await import(webRequire.resolve('vite'))
  return mergeConfig(await inbox(), {
  define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' },
  plugins: [conversationRenderMeter('phone')],
  build: { minify: true, rollupOptions: { input: resolve(import.meta.dirname, 'test/conversation-stream.browser.html') } },
  })
}
