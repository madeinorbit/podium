import { fileURLToPath } from 'node:url'
import { type ConfigEnv, defineConfig, mergeConfig, type UserConfig } from 'vite'
import harness from '../vite.harness.config'

const catalog = fileURLToPath(new URL('./context-usage-catalog.ts', import.meta.url))
export default defineConfig(async (env) =>
  mergeConfig(await (harness as (env: ConfigEnv) => Promise<UserConfig>)(env), {
    optimizeDeps: { entries: ['harness/context-usage.html'] },
    plugins: [
      {
        name: 'context-layout-catalog',
        enforce: 'pre',
        async resolveId(source, importer, options) {
          const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
          return /\/src\/lib\/use-(model-catalog|harness-descriptors)\.ts$/.test(resolved?.id ?? '')
            ? catalog
            : null
        },
      },
    ],
  }),
)
