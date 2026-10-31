import { homedir } from 'node:os'
import { join } from 'node:path'
import { type ConfigEnv, defineConfig, mergeConfig, type UserConfig } from 'vite'
import harness from './vite.harness.config'

export default defineConfig(async (env) =>
  mergeConfig(
    await (harness as (env: ConfigEnv) => Promise<UserConfig>)(env),
    // Bun's linked font packages resolve through its cache, outside the checkout.
    { server: { port: 55619, fs: { allow: [join(homedir(), '.bun/install/cache')] } } },
  ),
)
