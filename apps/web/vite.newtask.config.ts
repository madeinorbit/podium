// Throwaway harness config (POD-1285) — the real vite config with the PWA
// plugin dropped and `@/app/store` aliased to a stub, so the SHIPPING
// NewIssueDialog renders without a server behind it.
import { fileURLToPath } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import base from './vite.config'

export default defineConfig(async (env) => {
  const real = await (base as unknown as (e: typeof env) => Promise<Record<string, unknown>>)(env)
  const plugins = ((real.plugins as PluginOption[]) ?? []).filter(
    (p) => !(p && typeof p === 'object' && 'name' in p && String(p.name).includes('pwa')),
  )
  const resolve = (real.resolve ?? {}) as { alias?: Record<string, string> }
  return {
    ...real,
    plugins,
    resolve: {
      ...resolve,
      alias: {
        '@/app/store': fileURLToPath(new URL('./harness/newtask-store.ts', import.meta.url)),
        ...(resolve.alias ?? {}),
      },
    },
    root: fileURLToPath(new URL('.', import.meta.url)),
    server: {
      port: 55571,
      strictPort: true,
      fs: { allow: [fileURLToPath(new URL('../..', import.meta.url)), '/home/podium/podium'] },
    },
  }
})
