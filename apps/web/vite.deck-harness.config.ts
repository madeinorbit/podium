// Throwaway harness config for the flight deck — see harness/deck-entry.tsx.
// Same shape as vite.harness.config.ts (the shelf's), plus the one thing the
// deck needs that the shelf did not: `app/store` redirected to a stub, because
// `FlightDeck` reads the live store and a harness has no server behind it.
// Redirected by RESOLVED PATH rather than by specifier, so `./store` from inside
// src/app and `@/app/store` from everywhere else both land on the stub — exactly
// the single module id `FlightDeck.test.tsx` mocks.
import { fileURLToPath } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import base from './vite.config'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))
// The pool-backed deck (POD-2027) also reads the store handle and the worklist
// pool, so those resolve to the same fixtures `FlightDeck.test.tsx` mounts; the
// fixtures' vitest teardown hooks resolve to no-ops.
const STUBS = new Map([
  [here('./src/app/store.tsx'), here('./harness/deck-store-stub.ts')],
  [here('../../packages/client-core/src/react/provider.tsx'), here('./harness/deck-provider-stub.ts')],
  [here('./src/app/store-worklist-pool.ts'), here('./harness/deck-pool-stub.ts')],
])
const STUB_FILES = new Set(STUBS.values())
const VITEST_STUB = here('./harness/vitest-stub.ts')

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
        name: 'deck-harness-store-stub',
        enforce: 'pre',
        async resolveId(source: string, importer: string | undefined, opts: unknown) {
          if (source === 'vitest') return VITEST_STUB
          if (source.endsWith('deck-store-stub')) return null
          // A stub that wraps the real module must reach the real module.
          if (importer && STUB_FILES.has(importer.split('?')[0])) return null
          const resolved = await (
            this as unknown as {
              resolve: (
                s: string,
                i: string | undefined,
                o: Record<string, unknown>,
              ) => Promise<{ id: string } | null>
            }
          ).resolve(source, importer, { ...(opts as Record<string, unknown>), skipSelf: true })
          return (resolved && STUBS.get(resolved.id.split('?')[0])) ?? null
        },
      } as PluginOption,
    ],
    root: fileURLToPath(new URL('.', import.meta.url)),
    server: {
      port: 55601,
      strictPort: true,
      // Geist lives in the ROOT node_modules, outside this worktree, and vite's
      // default allow list refuses it — silently, as a fallback font. Line
      // wrapping is the whole measurement here, so that would make every number
      // a lie.
      // Bun links packages from its install cache, so Geist can resolve there too.
      fs: {
        allow: [
          fileURLToPath(new URL('../..', import.meta.url)),
          '/home/podium/podium',
          `${process.env.HOME}/.bun/install/cache`,
        ],
      },
    },
  }
})
