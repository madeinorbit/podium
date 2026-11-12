// Harness config for the sync item and panel (POD-6852). Same shape as
// vite.repos-settings-harness.config.ts: the real item, panel, review rows and
// stylesheet, with the pool readers and the store handle aliased to fixtures.
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
  const realAlias = (real.resolve as { alias?: Record<string, string> }).alias ?? {}
  return {
    ...real,
    plugins,
    root: fileURLToPath(new URL('.', import.meta.url)),
    resolve: {
      ...(real.resolve as Record<string, unknown>),
      // Stubs first: object aliases are prefix-matched in declaration order.
      alias: [
        { find: /^@\/app\/header-data$/, replacement: harness('sync-status-store.ts') },
        {
          // MessageNotices imports it relatively; both spellings reach the fixture.
          find: /^(?:@\/features\/chat|\.)\/use-pool-notices$/,
          replacement: harness('sync-status-store.ts'),
        },
        { find: /^@podium\/client-core\/react$/, replacement: harness('sync-status-store.ts') },
        ...Object.entries(realAlias).map(([find, replacement]) => ({ find, replacement })),
      ],
    },
    server: { port: 55614, strictPort: true, fs: { strict: false } },
  }
})
