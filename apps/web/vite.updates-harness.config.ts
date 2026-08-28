// Throwaway harness config for Settings → Updates (POD-2511). Same shape as
// vite.mobile-promo.config.ts: the real section, the real stylesheet, and
// `@/app/store` aliased to the scene stub so it renders with no server behind it.
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
        (String(p.name).includes('pwa') || String(p.name).includes('mobile-entry-redirect'))
      ),
  )
  return {
    ...real,
    plugins,
    root: fileURLToPath(new URL('.', import.meta.url)),
    resolve: {
      ...(real.resolve as Record<string, unknown>),
      // The stub goes FIRST: object aliases are prefix-matched in declaration
      // order, and the real config's bare `@` would otherwise swallow it.
      alias: {
        '@/app/store': fileURLToPath(new URL('./harness/updates-store.ts', import.meta.url)),
        ...((real.resolve as { alias: Record<string, string> }).alias ?? {}),
      },
    },
    server: { port: 55611, strictPort: true },
  }
})
