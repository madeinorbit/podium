// Throwaway harness config for the agent offer bar — see harness/offer-entry.tsx.
// Same shape as vite.deck-harness.config.ts: `app/store` redirected to a stub by
// RESOLVED PATH (so `./store` and `@/app/store` both land on it), because the
// offer's evidence strip reads the live store and a harness has no server.
// Plus one middleware: the strip's thumbnails are real bytes, since a broken
// <img> would leave the row a different height than the one that ships.
import { fileURLToPath } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import base from './vite.config'

const REAL_STORE = fileURLToPath(new URL('./src/app/store.tsx', import.meta.url))
const STUB_STORE = fileURLToPath(new URL('./harness/offer-store-stub.ts', import.meta.url))

/** A stand-in artifact thumbnail: a page of "work" at the offer's 70x44. */
const thumb = (tint: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 88">
    <rect width="140" height="88" fill="#f2f1ed"/>
    <rect x="8" y="8" width="58" height="72" fill="#ffffff" stroke="#e2e0d9"/>
    <rect x="74" y="8" width="58" height="72" fill="#ffffff" stroke="#e2e0d9"/>
    ${Array.from({ length: 7 }, (_, i) => i)
      .map(
        (i) =>
          `<rect x="12" y="${16 + i * 9}" width="50" height="5" fill="${i % 3 === 1 ? tint : '#e6e5e0'}"/>` +
          `<rect x="78" y="${16 + i * 9}" width="50" height="5" fill="${i % 3 === 2 ? tint : '#e6e5e0'}"/>`,
      )
      .join('')}
  </svg>`

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
        name: 'offer-harness-store-stub',
        enforce: 'pre',
        async resolveId(source: string, importer: string | undefined, opts: unknown) {
          if (source.endsWith('offer-store-stub')) return null
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
      {
        name: 'offer-harness-artifact-bytes',
        configureServer(server: {
          middlewares: {
            use: (
              fn: (
                req: { url?: string },
                res: {
                  setHeader: (k: string, v: string) => void
                  end: (b: string) => void
                },
                next: () => void,
              ) => void,
            ) => void
          }
        }) {
          server.middlewares.use((req, res, next) => {
            const url = req.url ?? ''
            if (!url.startsWith('/files/artifact/')) return next()
            res.setHeader('Content-Type', 'image/svg+xml')
            res.end(thumb(url.includes('art_b') ? '#d9b477' : '#8fa6d8'))
          })
        },
      } as PluginOption,
    ],
    root: fileURLToPath(new URL('.', import.meta.url)),
    server: {
      port: 55603,
      strictPort: true,
      // Geist lives in the ROOT node_modules, outside this worktree; vite's
      // default allow list refuses it silently and falls back to a system face,
      // which would change every wrap in the headline this harness is about.
      fs: { allow: [fileURLToPath(new URL('../..', import.meta.url)), '/home/podium/podium'] },
    },
  }
})
