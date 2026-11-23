import { fileURLToPath } from 'node:url'
import { type Alias, type ConfigEnv, defineConfig, mergeConfig, type UserConfig } from 'vite'
import base from './vite.settings-frame-harness.config'

// The settings-frame harness, with this harness's own client-core stub first.
const core = fileURLToPath(new URL('./harness/session-credentials-core.ts', import.meta.url))
export default defineConfig(async (env) => {
  const merged = mergeConfig(await (base as (env: ConfigEnv) => Promise<UserConfig>)(env), {
    server: { port: 55655, strictPort: true },
  }) as UserConfig
  const alias = (merged.resolve?.alias ?? []) as Alias[]
  return {
    ...merged,
    resolve: {
      ...merged.resolve,
      alias: [{ find: '@podium/client-core/react', replacement: core }, ...alias],
    },
  }
})
