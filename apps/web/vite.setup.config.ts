// The shipping onboarding screens over isolated model-backed fixtures.
import { fileURLToPath } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import base from './vite.config'

export default defineConfig(async (env) => {
  const real = await (base as unknown as (e: typeof env) => Promise<Record<string, unknown>>)(env)
  const plugins = ((real.plugins as PluginOption[]) ?? []).filter(
    (p) =>
      !(
        p &&
        typeof p === 'object' &&
        'name' in p &&
        /pwa|mobile-entry-redirect/.test(String(p.name))
      ),
  )
  const resolve = (real.resolve ?? {}) as { alias?: Record<string, string> }
  return {
    ...real,
    plugins,
    optimizeDeps: { entries: ['setup-harness.html'] },
    resolve: {
      ...resolve,
      alias: {
        '@/app/store-worklist-pool': fileURLToPath(
          new URL('./harness/setup-store.ts', import.meta.url),
        ),
        '@/features/settings/stable-access': fileURLToPath(
          new URL('./harness/setup-store.ts', import.meta.url),
        ),
        '@podium/client-core/react': fileURLToPath(
          new URL('./harness/setup-core.ts', import.meta.url),
        ),
        ...(resolve.alias ?? {}),
      },
    },
    root: fileURLToPath(new URL('.', import.meta.url)),
    server: {
      port: 55685,
      strictPort: true,
      host: '127.0.0.1',
      fs: { strict: false },
    },
  }
})
