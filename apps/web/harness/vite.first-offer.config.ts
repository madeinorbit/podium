// First Flights first-offer harness: the tips harness config, with the offer's
// store-backed evidence strip swapped for a stub (no runtime store here).
import { fileURLToPath } from 'node:url'
import { type ConfigEnv, defineConfig, mergeConfig, type UserConfig } from 'vite'
import tips from '../vite.tips.config'

const stub = fileURLToPath(new URL('./first-offer-strip-stub.tsx', import.meta.url))

export default defineConfig(async (env) =>
  mergeConfig(await (tips as (env: ConfigEnv) => Promise<UserConfig>)(env), {
    plugins: [
      {
        name: 'first-offer-strip-stub',
        enforce: 'pre',
        resolveId: (source: string, importer?: string) =>
          source === './OfferArtifactStrip' && importer?.endsWith('/OfferBar.tsx') ? stub : null,
      },
    ],
  }),
)
