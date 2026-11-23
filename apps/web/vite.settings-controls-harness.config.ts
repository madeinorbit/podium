import { type ConfigEnv, defineConfig, mergeConfig, type UserConfig } from 'vite'
import base from './vite.settings-frame-harness.config'
export default defineConfig(async (env) =>
  mergeConfig(await (base as (env: ConfigEnv) => Promise<UserConfig>)(env), {
    server: { port: 55653, strictPort: true },
  }),
)
