// Standalone sidebar layout with synthetic pool data and no PWA service worker.
import { fileURLToPath } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import base from './vite.config'

const REAL_DESCRIPTORS = fileURLToPath(
  new URL('./src/lib/use-harness-descriptors.ts', import.meta.url),
)
const REAL_CATALOG = fileURLToPath(new URL('./src/lib/use-model-catalog.ts', import.meta.url))
const STUB_CATALOG = fileURLToPath(new URL('./harness/sidebar-catalog-stub.ts', import.meta.url))

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
  return {
    ...real,
    plugins: [
      ...plugins,
      {
        name: 'sidebar-harness-catalog-stub',
        enforce: 'pre',
        async resolveId(source: string, importer: string | undefined, opts: unknown) {
          if (source.endsWith('sidebar-catalog-stub')) return null
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
    root: fileURLToPath(new URL('.', import.meta.url)),
    // Build only the standalone layout page.
    build: {
      ...((real.build as object) ?? {}),
      rollupOptions: {
        input: fileURLToPath(new URL('./sidebar-harness.html', import.meta.url)),
      },
    },
    server: {
      port: 55597,
      strictPort: true,
      // Geist lives in the ROOT node_modules, outside this worktree, and the
      // default allow list refuses it — silently, as a fallback face.
      fs: { allow: [fileURLToPath(new URL('../..', import.meta.url)), '/home/podium/podium'] },
    },
  }
})
