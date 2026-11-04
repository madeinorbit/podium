// Harness config for Settings → Accounts (POD-6300). Same shape as
// vite.updates-harness.config.ts: the real section, the real stylesheet, and the
// section's pool and transport imports aliased to fixtures.
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
  // The section imports `../stable-access` relatively, which no alias matches:
  // send every import of that module to the fixture transport.
  const stubStableAccess: PluginOption = {
    name: 'accounts-harness-stable-access',
    enforce: 'pre',
    resolveId(source) {
      return /(^|\/)stable-access$/.test(source) ? harness('accounts-settings-store.ts') : null
    },
  }
  return {
    ...real,
    plugins: [stubStableAccess, ...plugins],
    root: fileURLToPath(new URL('.', import.meta.url)),
    resolve: {
      ...(real.resolve as Record<string, unknown>),
      // The stubs go FIRST: object aliases are prefix-matched in declaration
      // order, and the real config's bare `@` would otherwise swallow them.
      alias: {
        '@/app/store-worklist-pool': harness('accounts-settings-store.ts'),
        '@/features/settings/stable-access': harness('accounts-settings-store.ts'),
        ...((real.resolve as { alias: Record<string, string> }).alias ?? {}),
      },
    },
    // Font files resolve through Bun's linked store, outside this root; the
    // harness only ever serves on localhost.
    server: { port: 55614, strictPort: true, fs: { strict: false } },
  }
})
