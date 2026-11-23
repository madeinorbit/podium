import { fileURLToPath } from 'node:url'
import { type ConfigEnv, defineConfig, type PluginOption, type UserConfig } from 'vite'
import base from './vite.config'

/** A disconnected menu fixture, with the product components and bundled marks. */
export default defineConfig(async (env) => {
  const config = await (base as (env: ConfigEnv) => Promise<UserConfig>)(env)
  const fixture = fileURLToPath(new URL('./harness/harness-menu-fixture.ts', import.meta.url))
  return {
    ...config,
    resolve: {
      ...config.resolve,
      alias: {
        '@/app/header-data': fixture,
        '@/lib/harness-descriptors': fixture,
        '@/lib/use-feature': fixture,
        '@/features/credentials/session/NewSessionCredentialSection': fixture,
        '@/features/files/artifacts-tab': fixture,
        ...(config.resolve?.alias as Record<string, string>),
      },
    },
    optimizeDeps: { ...config.optimizeDeps, entries: ['harness/harness-menu.html'] },
    plugins: [
      ...((config.plugins as PluginOption[]) ?? []).filter(
        (plugin) =>
          !(
            plugin &&
            typeof plugin === 'object' &&
            'name' in plugin &&
            /pwa|mobile-entry-redirect/.test(String(plugin.name))
          ),
      ),
      {
        name: 'harness-menu-launch-inputs',
        enforce: 'pre' as const,
        resolveId(source: string, importer?: string) {
          if (source === './command-launch-data' && importer?.endsWith('/app/NewPanelMenu.tsx'))
            return fixture
        },
      },
    ],
    server: { port: 55664, strictPort: true, host: '127.0.0.1', fs: { strict: false }, proxy: {} },
  }
})
