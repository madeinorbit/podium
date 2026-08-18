// Throwaway harness config — see the shelf harness in harness/shelf-entry.tsx.
// Reuses the real vite config (which exports a FUNCTION, so it is awaited) and
// drops the PWA plugin, whose service worker would serve a stale bundle.
import { fileURLToPath } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import base from './vite.config'

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
      port: 55597,
      strictPort: true,
      // Geist lives in the ROOT node_modules, outside this worktree, and the
      // default allow list refuses it. Line wrapping is the whole measurement
      // here, so a fallback font would make every number a lie.
      fs: { allow: [fileURLToPath(new URL('../..', import.meta.url)), '/home/podium/podium'] },
    },
  }
})
