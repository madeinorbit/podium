/** Isolated reader proof, not an Expo app or complete Inbox acceptance. */
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { resolveMobileFile, resolveMobilePackage, resolveRootFile, resolveRootPackage } from './resolve-package'

// The isolated linker puts Vite and its React plugin under the web package,
// which declares them. Ask that owner instead of falling through to another
// checkout's node_modules while loading a config from the mobile directory.
const webRequire = createRequire(new URL('../web/package.json', import.meta.url))

const platform = fileURLToPath(new URL('./test/inbox-platform.tsx', import.meta.url))
export default async () => {
  const { default: react } = await import(webRequire.resolve('@vitejs/plugin-react'))
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    define: { __DEV__: 'true', 'process.env.NODE_ENV': '"development"' },
    plugins: [react()],
    cacheDir: 'node_modules/.cache/mobile-inbox-vite',
    resolve: {
      conditions: ['@podium/source'],
      extensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'],
      alias: [
        { find: /^react-native$/, replacement: resolveMobilePackage('react-native-web') },
        { find: /^expo-blur$/, replacement: fileURLToPath(new URL('./harness/stub-expo-blur.tsx', import.meta.url)) },
        { find: /^expo-haptics$/, replacement: fileURLToPath(new URL('./harness/stub-expo-haptics.ts', import.meta.url)) },
        { find: /^react-native-safe-area-context$/, replacement: fileURLToPath(new URL('./harness/stub-safe-area.ts', import.meta.url)) },
        { find: /^expo-symbols$/, replacement: fileURLToPath(new URL('./harness/stub-expo-symbols.tsx', import.meta.url)) },
        { find: /^react-native-svg$/, replacement: resolveMobileFile('react-native-svg/lib/module/ReactNativeSVG.web.js') },
        { find: /^react$/, replacement: resolveRootPackage('react') },
        { find: /^react-dom$/, replacement: resolveRootPackage('react-dom') },
        { find: /^react-dom\/client$/, replacement: resolveRootFile('react-dom/client') },
        { find: /^expo-router$/, replacement: platform },
        { find: /^(\.\.\/client|\.)\/server-profile-context$/, replacement: platform },
        { find: /^\.\.\/hooks\/useContentBottomInset$/, replacement: platform },
        {
          find: /^\.\.\/components\/(NewWorkButton|StorageNoticeAlert|RefreshOffer|ScreeningCard)$/,
          replacement: platform,
        },
      ],
    },
    optimizeDeps: {
      entries: ['test/inbox.browser.html'],
      exclude: ['expo-blur', 'expo-haptics', 'expo-symbols', 'react-native-safe-area-context', 'react-native-svg'],
    },
    server: { host: '127.0.0.1', hmr: false, port: 45172, strictPort: true },
  }
}
