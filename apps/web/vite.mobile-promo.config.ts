// Throwaway harness config for the mobile-handoff surfaces (POD-1320). Same
// shape as vite.harness.config.ts, plus one alias: `@/app/store` becomes the
// stub in harness/mobile-promo-store.ts so the real components can render with
// no server behind them.
import { fileURLToPath } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import base from './vite.config'

export default defineConfig(async (env) => {
  const real = await (base as unknown as (e: typeof env) => Promise<Record<string, unknown>>)(env)
  const plugins = ((real.plugins as PluginOption[]) ?? []).filter(
    (p) => !(p && typeof p === 'object' && 'name' in p && String(p.name).includes('pwa')),
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
        '@/app/store': fileURLToPath(new URL('./harness/mobile-promo-store.ts', import.meta.url)),
        ...((real.resolve as { alias: Record<string, string> }).alias ?? {}),
      },
    },
    server: {
      port: 55601,
      strictPort: true,
      fs: { allow: [fileURLToPath(new URL('../..', import.meta.url)), '/home/podium/podium'] },
    },
  }
})
