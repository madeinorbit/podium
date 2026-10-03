/** Isolated reader proof, not an Expo app or complete Inbox acceptance. */
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vite'
import mobileHarness from './vite.harness.config'

const platform = fileURLToPath(new URL('./test/inbox-platform.tsx', import.meta.url))
export default mergeConfig(mobileHarness, defineConfig({
  cacheDir: 'node_modules/.cache/mobile-inbox-vite',
  resolve: {
    conditions: ['@podium/source'],
    alias: [
      { find: /^expo-router$/, replacement: platform },
      { find: /^(\.\.\/client|\.)\/server-profile-context$/, replacement: platform },
      { find: /^\.\.\/hooks\/useContentBottomInset$/, replacement: platform },
      { find: /^\.\.\/components\/(NewWorkButton|StorageNoticeAlert|RefreshOffer|ScreeningCard)$/, replacement: platform },
    ],
  },
  optimizeDeps: { entries: ['test/inbox.browser.html'] },
  server: { host: '127.0.0.1', hmr: false, port: 45172, strictPort: true },
}))
