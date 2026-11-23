import { fileURLToPath } from 'node:url'
import { type ConfigEnv, defineConfig, mergeConfig, type UserConfig } from 'vite'
import harness from '../vite.harness.config'

const stub = fileURLToPath(new URL('./command-execution-pool-stub.ts', import.meta.url))
export default defineConfig(async (env) =>
  mergeConfig(await (harness as (env: ConfigEnv) => Promise<UserConfig>)(env), {
    plugins: [
      {
        name: 'command-execution-layout-pool',
        enforce: 'pre',
        resolveId: (source: string) =>
          source.replace(/\.tsx?$/, '').endsWith('/src/app/store-worklist-pool') ? stub : null,
      },
    ],
  }),
)
