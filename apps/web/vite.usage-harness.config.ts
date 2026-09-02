// Throwaway harness config for the whole usage sheet — see
// harness/usage-sheet-entry.tsx. Same shape as the deck's, and for the same one
// reason: `UsageView` reads the live store for its tRPC client, and a harness
// has no server behind it. Redirected by RESOLVED PATH rather than by specifier,
// so `./store` from inside src/app and `@/app/store` from everywhere else both
// land on the stub — exactly the single module id `UsageView.test.tsx` mocks.
import { fileURLToPath } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import base from './vite.config'

const REAL_STORE = fileURLToPath(new URL('./src/app/store.tsx', import.meta.url))
const STUB_STORE = fileURLToPath(new URL('./harness/usage-sheet-store-stub.ts', import.meta.url))

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
        name: 'usage-harness-store-stub',
        enforce: 'pre',
        async resolveId(source: string, importer: string | undefined, opts: unknown) {
          if (source.endsWith('usage-sheet-store-stub')) return null
          const resolved = await (
            this as unknown as {
              resolve: (
                s: string,
                i: string | undefined,
                o: Record<string, unknown>,
              ) => Promise<{ id: string } | null>
            }
          ).resolve(source, importer, { ...(opts as Record<string, unknown>), skipSelf: true })
          if (resolved && resolved.id.split('?')[0] === REAL_STORE) return STUB_STORE
          return null
        },
      } as PluginOption,
    ],
    root: fileURLToPath(new URL('.', import.meta.url)),
    server: {
      port: 55602,
      strictPort: true,
      // Geist lives in the ROOT node_modules, outside this worktree, and vite's
      // default allow list refuses it — silently, as a fallback font. Column
      // alignment is the whole measurement here, and tabular figures in a
      // fallback face would make every right edge a lie.
      fs: { allow: [fileURLToPath(new URL('../..', import.meta.url)), '/home/podium/podium'] },
    },
  }
})
