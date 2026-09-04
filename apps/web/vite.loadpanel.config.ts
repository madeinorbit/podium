// Throwaway harness config (POD-1603) — the real vite config with the PWA
// plugin dropped and `@/app/store` aliased to a stub, so the SHIPPING
// LoadPanel renders without a server behind it.
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
        /pwa|workbox/i.test(String((p as { name: string }).name))
      ),
  )
  const resolve = (real.resolve ?? {}) as { alias?: Record<string, string> }
  return {
    ...real,
    plugins,
    resolve: {
      ...resolve,
      // BEFORE the spread, or the real config's bare '@' alias swallows it.
      alias: {
        '@/app/store': fileURLToPath(new URL('./harness/loadpanel-store.ts', import.meta.url)),
        ...(resolve.alias ?? {}),
      },
    },
    root: fileURLToPath(new URL('.', import.meta.url)),
    // ONLY the harness page. The real `index.html` pulls in the whole app, whose
    // other surfaces import store exports this stub has no reason to carry — and
    // the build fails on them rather than tree-shaking them away.
    build: {
      ...((real.build as object) ?? {}),
      rollupOptions: {
        input: fileURLToPath(new URL('./harness/loadpanel.html', import.meta.url)),
      },
    },
    server: {
      port: 55611,
      strictPort: true,
      // Geist lives in the ROOT node_modules, outside this worktree, and the
      // default allow list refuses it — silently, as a fallback face.
      fs: { allow: [fileURLToPath(new URL('../..', import.meta.url)), '/home/podium/podium'] },
    },
  }
})
