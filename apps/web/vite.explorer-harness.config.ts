// Throwaway harness config for the task explorer — see harness/explorer-entry.tsx.
// Same shape as vite.issue-page-harness.config.ts: `app/store` is redirected to a
// stub by RESOLVED PATH rather than by specifier, so `./store` from inside src/app
// and `@/app/store` from everywhere else both land on it.
import { fileURLToPath } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import base from './vite.config'

const REAL_STORE = fileURLToPath(new URL('./src/app/store.tsx', import.meta.url))
const STUB_STORE = fileURLToPath(new URL('./harness/explorer-store.ts', import.meta.url))
// The launch box's model + effort segments read the live catalog, and that hook
// hangs off the real store provider rather than the stub above — see
// harness/model-catalog-stub.ts.
const REAL_CATALOG = fileURLToPath(new URL('./src/lib/use-model-catalog.ts', import.meta.url))
const STUB_CATALOG = fileURLToPath(new URL('./harness/model-catalog-stub.ts', import.meta.url))

export default defineConfig(async (env) => {
  const real = await (base as unknown as (e: typeof env) => Promise<Record<string, unknown>>)(env)
  const plugins = ((real.plugins as PluginOption[]) ?? []).filter(
    (p) => !(p && typeof p === 'object' && 'name' in p && String(p.name).includes('pwa')),
  )
  return {
    ...real,
    plugins: [
      ...plugins,
      {
        name: 'explorer-harness-store-stub',
        enforce: 'pre',
        async resolveId(source: string, importer: string | undefined, opts: unknown) {
          if (source.endsWith('explorer-store') || source.endsWith('model-catalog-stub'))
            return null
          const resolved = await (
            this as unknown as {
              resolve: (
                s: string,
                i: string | undefined,
                o: Record<string, unknown>,
              ) => Promise<{ id: string } | null>
            }
          ).resolve(source, importer, { ...(opts as Record<string, unknown>), skipSelf: true })
          const id = resolved?.id.split('?')[0]
          if (id === REAL_STORE) return STUB_STORE
          if (id === REAL_CATALOG) return STUB_CATALOG
          return null
        },
      } as PluginOption,
    ],
    root: fileURLToPath(new URL('.', import.meta.url)),
    server: {
      port: 55604,
      strictPort: true,
      // Geist lives in the ROOT node_modules, outside this worktree, and vite's
      // default allow list refuses it — silently, as a fallback font.
      fs: { allow: [fileURLToPath(new URL('../..', import.meta.url)), '/home/podium/podium'] },
    },
  }
})
