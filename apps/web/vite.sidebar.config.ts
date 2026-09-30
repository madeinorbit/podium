// Throwaway harness config (POD-1253) — the real vite config with the PWA
// plugin dropped and `@/app/store` aliased to a stub, so the SHIPPING
// SidebarUnified renders without a server behind it.
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
  const resolve = (real.resolve ?? {}) as { alias?: Record<string, string> }
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
    resolve: {
      ...resolve,
      // BEFORE the spread, or the real config's bare '@' alias swallows it.
      alias: {
        '@/app/store': fileURLToPath(new URL('./harness/sidebar-store.ts', import.meta.url)),
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
