import { resolve } from 'node:path'
import conversation from './vite.conversation-stream.config'
import { resolveMobileFile } from './resolve-package'

export default async () => {
  const config = await conversation()
  config.plugins = config.plugins.filter(
    (plugin: { name?: string }) => plugin.name !== 'conversation-render-meter',
  )
  config.resolve.alias.push(
    { find: /^expo-clipboard$/, replacement: resolveMobileFile('expo-clipboard/build/Clipboard.js') },
    { find: /^expo\/fetch$/, replacement: resolveMobileFile('expo/src/winter/fetch/fetch.web.ts') },
  )
  // The terminal's native webview is closed on these web-only review surfaces.
  config.plugins.push({
    name: 'working-mark-native-webview',
    resolveId(id: string) {
      if (id === '@expo/dom-webview') return '\0working-mark-native-webview'
    },
    load(id: string) {
      if (id === '\0working-mark-native-webview') return 'export const WebView = () => null'
    },
  })
  config.optimizeDeps.entries = ['test/working-mark.browser.html']
  config.optimizeDeps.noDiscovery = true
  config.optimizeDeps.include = ['react', 'react-dom/client', 'react-native-web']
  config.build.rolldownOptions.input = resolve(import.meta.dirname, 'test/working-mark.browser.html')
  config.server.port = 45174
  return config
}
