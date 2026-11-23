// The Concertmaster scene's own dev server: the shared harness config, with
// the dependency scan held to this one page (the default scan walks every
// harness page, the phone's included).
// bun --bun x vite --config harness/vite.concertmaster.config.ts
import { type ConfigEnv, defineConfig, mergeConfig, type UserConfig } from 'vite'
import harness from '../vite.harness.config'

export default defineConfig(async (env) =>
  mergeConfig(await (harness as (env: ConfigEnv) => Promise<UserConfig>)(env), {
    optimizeDeps: { entries: ['harness/concertmaster.html'] },
  }),
)
