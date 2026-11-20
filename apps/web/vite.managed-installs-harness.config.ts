import { type ConfigEnv, defineConfig, type PluginOption, type UserConfig } from 'vite'
import base from './vite.config'

/** Product aliases and source conditions, with no live backend or PWA redirection. */
export default defineConfig(async (env) => {
  const config = await (base as (env: ConfigEnv) => Promise<UserConfig>)(env)
  return {
    ...config,
    plugins: ((config.plugins as PluginOption[]) ?? []).filter(
      (plugin) =>
        !(
          plugin &&
          typeof plugin === 'object' &&
          'name' in plugin &&
          /pwa|mobile-entry-redirect/.test(String(plugin.name))
        ),
    ),
    server: { port: 55658, strictPort: true, host: '127.0.0.1', fs: { strict: false } },
  }
})
