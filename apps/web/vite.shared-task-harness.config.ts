// Harness config for the shared task detail — see harness/shared-task-entry.tsx
// (POD-6295). `lib/member-roster` is redirected to a three-member stub by
// RESOLVED PATH, the way vite.issue-page-harness.config.ts stubs the store, so
// the page's leaf components name members without a running pool.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import base from './vite.config'

const fontRoots = ['geist', 'geist-mono'].map((font) =>
  realpathSync(
    fileURLToPath(new URL(`./node_modules/@fontsource-variable/${font}`, import.meta.url)),
  ),
)
const REAL_ROSTER = fileURLToPath(new URL('./src/lib/member-roster.tsx', import.meta.url))
const STUB_ROSTER = fileURLToPath(new URL('./harness/shared-task-roster.tsx', import.meta.url))

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
        name: 'shared-task-harness-roster-stub',
        enforce: 'pre',
        async resolveId(source: string, importer: string | undefined, opts: unknown) {
          if (source.endsWith('shared-task-roster')) return null
          const resolved = await (
            this as unknown as {
              resolve: (
                s: string,
                i: string | undefined,
                o: Record<string, unknown>,
              ) => Promise<{ id: string } | null>
            }
          ).resolve(source, importer, { ...(opts as Record<string, unknown>), skipSelf: true })
          if (resolved && resolved.id.split('?')[0] === REAL_ROSTER) return STUB_ROSTER
          return null
        },
      } as PluginOption,
    ],
    root: fileURLToPath(new URL('.', import.meta.url)),
    server: {
      port: 55603,
      strictPort: true,
      fs: {
        allow: [
          fileURLToPath(new URL('../..', import.meta.url)),
          '/home/podium/podium',
          ...fontRoots,
        ],
      },
    },
  }
})
