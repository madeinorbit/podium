// Harness config for Settings → Projects (POD-6267). Same shape as
// vite.updates-harness.config.ts: the real section, the real stylesheet, and the
// section's pool, write and branch-menu imports aliased to fixtures.
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
      // The stubs go FIRST: object aliases are prefix-matched in declaration
      // order, and the real config's bare `@` would otherwise swallow them.
      alias: {
        '@/app/store-worklist-pool': harness('repos-settings-store.ts'),
        '@/features/settings/stable-access': harness('repos-settings-store.ts'),
        '@/lib/BaseBranchMenu': harness('repos-settings-branch-menu.tsx'),
        ...((real.resolve as { alias: Record<string, string> }).alias ?? {}),
      },
    },
    // Font files resolve through Bun's linked store, outside this root; the
    // harness only ever serves on localhost.
    server: { port: 55613, strictPort: true, fs: { strict: false } },
  }
})
