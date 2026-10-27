// Throwaway harness config for the First Flights ask-anything tip (POD-2198) —
// see harness/ask-anything-entry.tsx. The real composer reads `app/store` and
// `use-chat-context`; both are redirected by RESOLVED PATH to stubs, the same
// way vite.offer-harness.config.ts does it.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import base from './vite.config'

const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url))
const REDIRECTS = new Map([
  [at('./src/app/store.tsx'), at('./harness/offer-store-stub.ts')],
  [
    at('./src/features/chat/use-chat-context.ts'),
    at('./harness/ask-anything-chat-context-stub.ts'),
  ],
])

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
        name: 'ask-anything-harness-stubs',
        enforce: 'pre',
        async resolveId(source: string, importer: string | undefined, opts: unknown) {
          if (source.endsWith('-stub') || source.endsWith('-stub.ts')) return null
          const resolved = await (
            this as unknown as {
              resolve: (
                s: string,
                i: string | undefined,
                o: Record<string, unknown>,
              ) => Promise<{ id: string } | null>
            }
          ).resolve(source, importer, { ...(opts as Record<string, unknown>), skipSelf: true })
          return REDIRECTS.get(resolved?.id.split('?')[0] ?? '') ?? null
        },
      } as PluginOption,
    ],
    root: at('.'),
    server: {
      port: 55621,
      strictPort: true,
      // Bun's linked font packages resolve through its cache, outside the checkout.
      fs: { allow: [at('../..'), join(homedir(), '.bun/install/cache')] },
    },
  }
})
