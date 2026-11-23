import { fileURLToPath } from 'node:url'
import { resolveMobilePackage } from './resolve-package'
import base from './vite.harness.config'

const harness = (file: string) => fileURLToPath(new URL(`./harness/${file}`, import.meta.url))
export default async () => {
  const real = await base()
  return {
    ...real,
    resolve: {
      ...real.resolve,
      conditions: ['@podium/source', 'module', 'browser', 'development', 'import', 'default'],
      alias: [
        { find: /^\.\/BottomSheet$/, replacement: harness('agent-setup-bottom-sheet.tsx') },
        { find: /^\.\/platform-colors$/, replacement: harness('agent-setup-colors.ts') },
        { find: /^react-native-svg$/, replacement: harness('agent-setup-svg.tsx') },
        { find: /^\.\.\/client\/hooks$/, replacement: harness('agent-setup-browser.tsx') },
        { find: /^\.\.\/client\/mobile-pool$/, replacement: harness('agent-setup-browser.tsx') },
        { find: /^\.\.\/terminal\/TerminalPane$/, replacement: harness('agent-setup-browser.tsx') },
        { find: /^expo-clipboard$/, replacement: harness('agent-setup-browser.tsx') },
        ...real.resolve.alias,
      ],
    },
    optimizeDeps: { ...real.optimizeDeps, entries: ['agent-setup-harness.html'] },
    server: {
      port: 8097,
      strictPort: true,
      fs: {
        allow: [
          fileURLToPath(new URL('../../', import.meta.url)),
          resolveMobilePackage('@expo-google-fonts/geist'),
          resolveMobilePackage('@expo-google-fonts/geist-mono'),
        ],
      },
    },
  }
}
