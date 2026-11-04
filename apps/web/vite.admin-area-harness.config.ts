// Harness config for Settings → Administration (POD-6299). Same shape as
// vite.accounts-settings-harness.config.ts: the real sections and stylesheet,
// the pool aliased to a fixture; the entry stubs fetch as the server.
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
        '@/app/store-worklist-pool': harness('admin-area-pool.ts'),
        ...((real.resolve as { alias: Record<string, string> }).alias ?? {}),
      },
    },
    // Font files resolve through Bun's linked store, outside this root; the
    // harness only ever serves on localhost.
    server: { port: 55615, strictPort: true, fs: { strict: false } },
  }
})
