// Harness config for Settings → Accounts & Keys (POD-6390). Same shape as
// vite.repos-settings-harness.config.ts: the real section and stylesheet, with
// the section's pool, tRPC and member-directory imports aliased to a fixture.
import { fileURLToPath } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import base from './vite.config'

const harness = (file: string) => fileURLToPath(new URL(`./harness/${file}`, import.meta.url))

export default defineConfig(async (env) => {
  const real = await (base as unknown as (e: typeof env) => Promise<Record<string, unknown>>)(env)
  const plugins = ((real.plugins as PluginOption[]) ?? []).filter(
    (p) =>
      !(
        p &&
        typeof p === 'object' &&
        'name' in p &&
        (String(p.name).includes('pwa') || String(p.name).includes('mobile-entry-redirect'))
      ),
  )
  return {
    ...real,
    plugins,
    root: fileURLToPath(new URL('.', import.meta.url)),
    resolve: {
      ...(real.resolve as Record<string, unknown>),
      // The stubs go FIRST, as patterns: the section imports `../stable-access`
      // relatively, which a `@/` prefix alias would not catch.
      alias: [
        { find: /^.*\/store-worklist-pool$/, replacement: harness('accounts-settings-store.ts') },
        { find: /^.*\/stable-access$/, replacement: harness('accounts-settings-store.ts') },
        { find: /^.*\/setup\/member-api$/, replacement: harness('accounts-settings-store.ts') },
        ...Object.entries((real.resolve as { alias: Record<string, string> }).alias ?? {}).map(
          ([find, replacement]) => ({ find, replacement }),
        ),
      ],
    },
    server: { port: 55614, strictPort: true, fs: { strict: false } },
  }
})
