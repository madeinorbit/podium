// Throwaway harness config (POD-1203) — the real vite config with the PWA
// plugin dropped and `@/app/store` aliased to a stub, so the SHIPPING
// ColdStartComposer renders without a server behind it.
import { fileURLToPath } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import base from './vite.config'

const REAL_CATALOG = fileURLToPath(new URL('./src/lib/use-model-catalog.ts', import.meta.url))
const STUB_CATALOG = fileURLToPath(new URL('./harness/model-catalog-stub.ts', import.meta.url))

export default defineConfig(async (env) => {
  const real = await (base as unknown as (e: typeof env) => Promise<Record<string, unknown>>)(env)
  const plugins = ((real.plugins as PluginOption[]) ?? []).filter(
    (p) => !(p && typeof p === 'object' && 'name' in p && String(p.name).includes('pwa')),
  )
  const resolve = (real.resolve ?? {}) as { alias?: Record<string, string> }
  return {
    ...real,
    plugins: [
      ...plugins,
      {
        // THE CATALOG IS REDIRECTED BY RESOLVED PATH, NOT BY SPECIFIER
        // (POD-1457, adopted here by POD-1469). The model + effort segments read
        // the LIVE catalog through a hook that hangs off the real store provider
        // rather than the `@/app/store` stub below, so mounting this box without
        // the swap throws on a context the harness never sets up — and an alias
        // on `@/lib/use-model-catalog` would miss the picker's own relative
        // `./use-model-catalog`. Resolve first, compare ids, then substitute.
        name: 'coldstart-harness-catalog-stub',
        enforce: 'pre',
        async resolveId(source: string, importer: string | undefined, opts: unknown) {
          if (source.endsWith('model-catalog-stub')) return null
          const resolved = await (
            this as unknown as {
              resolve: (
                s: string,
                i: string | undefined,
                o: Record<string, unknown>,
              ) => Promise<{ id: string } | null>
            }
          ).resolve(source, importer, { ...(opts as Record<string, unknown>), skipSelf: true })
          return resolved?.id.split('?')[0] === REAL_CATALOG ? STUB_CATALOG : null
        },
      } as PluginOption,
    ],
    resolve: {
      ...resolve,
      alias: {
        '@/app/store': fileURLToPath(new URL('./harness/coldstart-store.ts', import.meta.url)),
        ...(resolve.alias ?? {}),
      },
    },
    root: fileURLToPath(new URL('.', import.meta.url)),
    server: {
      port: 55598,
      strictPort: true,
      fs: { allow: [fileURLToPath(new URL('../..', import.meta.url)), '/home/podium/podium'] },
    },
  }
})
