// The session model chip's pending state (POD-6523): stubbed store, pool and
// model catalog, no PWA service worker.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import base from './vite.config'

const REAL_DESCRIPTORS = fileURLToPath(
  new URL('./src/lib/use-harness-descriptors.ts', import.meta.url),
)
const REAL_CATALOG = fileURLToPath(new URL('./src/lib/use-model-catalog.ts', import.meta.url))
const STUB_CATALOG = fileURLToPath(new URL('./harness/model-chip-catalog-stub.ts', import.meta.url))
const STUB_STORE = fileURLToPath(new URL('./harness/model-chip-store.ts', import.meta.url))
const STUB_POOL = fileURLToPath(new URL('./harness/model-chip-pool.ts', import.meta.url))
const FONT_ASSET_ROOTS = ['geist', 'geist-mono'].map((font) =>
  realpathSync(new URL(`./node_modules/@fontsource-variable/${font}/files`, import.meta.url)),
)

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
    plugins: [
      ...plugins,
      {
        name: 'model-chip-harness-stubs',
        enforce: 'pre',
        async resolveId(source: string, importer: string | undefined, opts: unknown) {
          if (source.endsWith('model-chip-catalog-stub')) return null
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
          if (id === REAL_DESCRIPTORS || id === REAL_CATALOG) return STUB_CATALOG
          return null
        },
      } as PluginOption,
    ],
    resolve: {
      ...resolve,
      alias: {
        '@/app/store-worklist-pool': STUB_POOL,
        '@/app/store': STUB_STORE,
        ...(resolve.alias ?? {}),
      },
    },
    root: fileURLToPath(new URL('.', import.meta.url)),
    server: {
      port: 55595,
      strictPort: true,
      // Bun can link font assets outside the worktree. Allow only their files directories.
      fs: {
        allow: [
          fileURLToPath(new URL('../..', import.meta.url)),
          '/home/podium/podium',
          ...FONT_ASSET_ROOTS,
        ],
      },
    },
  }
})
