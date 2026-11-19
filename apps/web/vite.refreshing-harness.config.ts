import { fileURLToPath } from 'node:url'
import type { ConfigEnv, PluginOption, UserConfig } from 'vite'
import mobile from '../mobile/vite.harness.config'
import base from './vite.harness.config'

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const STUBS = new Map([
  [at('./src/app/store.tsx'), at('./harness/deck-store-stub.ts')],
  [at('./src/app/store-worklist-pool.ts'), at('./harness/refreshing-pool.ts')],
  [at('../../packages/client-core/src/react/index.ts'), at('./harness/refreshing-runtime.ts')],
  [at('../mobile/src/client/mobile-pool.ts'), at('./harness/refreshing-pool.ts')],
  ...[
    'client/hooks.ts',
    'client/member-roster.ts',
    'client/use-issue-close.ts',
    'hooks/useContentBottomInset.ts',
    'hooks/useMinimizeTabBarOnScroll.web.ts',
    'hooks/useRefreshableTab.tsx',
    ...[
      'ActionSheet',
      'IssueCloseSheet',
      'StorageNoticeAlert',
      'RefreshOffer',
      'NotSavedMark',
      'TaskFiltersSheet',
      'WorkIssueMenu',
      'ConfiguredIssueLaunchSheet',
    ].map((name) => `components/${name}.tsx`),
  ].map((path) => [at(`../mobile/src/${path}`), at('./harness/refreshing-mobile.tsx')]),
])
const stubFiles = new Set(STUBS.values())

export default async (env: ConfigEnv) => {
  const real = await (base as (value: ConfigEnv) => Promise<UserConfig>)(env)
  const native = await mobile()
  return {
    ...real,
    define: { ...real.define, __DEV__: 'true', 'process.env.EXPO_OS': '"web"' },
    resolve: {
      ...real.resolve,
      extensions: native.resolve.extensions,
      alias: [
        {
          find: /^react-native-svg$/,
          replacement: at('./harness/refreshing-svg.tsx'),
        },
        { find: /^expo-symbols$/, replacement: at('./harness/refreshing-symbols.tsx') },
        { find: /^expo-router$/, replacement: at('./harness/refreshing-mobile.tsx') },
        {
          find: /^expo-router\/build\/react-navigation\/bottom-tabs$/,
          replacement: at('./harness/refreshing-mobile.tsx'),
        },
        ...native.resolve.alias,
        { find: '@', replacement: at('./src') },
      ],
    },
    plugins: [
      {
        name: 'refreshing-authority-stubs',
        enforce: 'pre',
        async resolveId(source, importer, opts) {
          if (source === 'vitest') return at('./harness/vitest-stub.ts')
          if (importer && stubFiles.has(importer.split('?')[0]!)) return null
          const resolved = await this.resolve(source, importer, { ...opts, skipSelf: true })
          return resolved ? STUBS.get(resolved.id.split('?')[0]!) : null
        },
      } satisfies PluginOption,
      ...(real.plugins ?? []),
    ],
    optimizeDeps: {
      ...real.optimizeDeps,
      exclude: [...(real.optimizeDeps?.exclude ?? []), ...native.optimizeDeps.exclude],
      entries: ['harness/refreshing.html'],
    },
    server: { ...real.server, port: 55616, strictPort: true },
  }
}
