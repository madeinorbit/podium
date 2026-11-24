import { type ConfigEnv, defineConfig, type PluginOption, type UserConfig } from 'vite'
import base from './vite.config'

export default defineConfig(async (env) => {
  const config = await (base as (env: ConfigEnv) => Promise<UserConfig>)(env)
  return {
    ...config,
    optimizeDeps: { ...config.optimizeDeps, entries: ['harness/machine-presence.html'] },
    plugins: ((config.plugins as PluginOption[]) ?? []).filter(
      (plugin) =>
        !(
          plugin &&
          typeof plugin === 'object' &&
          'name' in plugin &&
          /pwa|mobile-entry-redirect/.test(String(plugin.name))
        ),
    ),
    server: { host: '127.0.0.1', port: 55652, strictPort: true, proxy: {}, fs: { strict: false } },
  }
})
