import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import inbox from './vite.inbox.config'
import { conversationRenderMeter } from '../web/harness/conversation-render-meter'
import { resolveThroughMobileDep } from './resolve-package'

const webRequire = createRequire(new URL('../web/package.json', import.meta.url))
export default async () => {
  const { mergeConfig } = await import(webRequire.resolve('vite'))
  const base = await inbox()
  base.resolve.alias = base.resolve.alias.map(alias => ({ ...alias,
    replacement: alias.replacement.endsWith('/inbox-platform.tsx')
      ? resolve(import.meta.dirname, 'test/conversation-stream-platform.tsx') : alias.replacement,
  }))
  base.resolve.alias.push({ find: /^expo-modules-core$/, replacement: resolveThroughMobileDep('expo', 'expo-modules-core') })
  return mergeConfig(base, {
  define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"', 'process.env.EXPO_OS': '"web"' },
  plugins: [conversationRenderMeter('phone'), {
    name: 'expo-global-type-imports', enforce: 'pre',
    transform(code: string, id: string) {
      // Expo's declaration-only namespace imports are type imports under Metro.
      if (id.endsWith('/expo-modules-core/src/ts-declarations/global.ts'))
        return { code: code.replace(/^import \{/gm, 'import type {'), map: null }
    },
  }],
  build: { minify: true, rolldownOptions: { moduleTypes: { '.js': 'jsx' }, input: resolve(import.meta.dirname, 'test/conversation-stream.browser.html') } },
  })
}
