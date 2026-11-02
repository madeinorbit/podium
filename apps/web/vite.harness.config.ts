// Throwaway harness config — see the shelf harness in harness/shelf-entry.tsx.
// Reuses the real vite config (which exports a FUNCTION, so it is awaited) and
// drops the PWA plugin, whose service worker would serve a stale bundle.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import base from './vite.config'

const fontRoots = ['geist', 'geist-mono'].map((font) =>
  realpathSync(
    fileURLToPath(new URL(`./node_modules/@fontsource-variable/${font}`, import.meta.url)),
  ),
)

export default defineConfig(async (env) => {
  const real = await (base as unknown as (e: typeof env) => Promise<Record<string, unknown>>)(env)
  const plugins = ((real.plugins as PluginOption[]) ?? []).filter(
    (p) => !(p && typeof p === 'object' && 'name' in p && String(p.name).includes('pwa')),
  )
  return {
    ...real,
    plugins,
    root: fileURLToPath(new URL('.', import.meta.url)),
    server: {
      port: 55599,
      strictPort: true,
      // Bun can resolve Geist through its shared cache outside the checkout.
      // Permit those font packages so screenshots use the shipping typefaces.
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
