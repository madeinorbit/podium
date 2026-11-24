import { fileURLToPath } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import base from './vite.config'

const fixture = (file: string) => fileURLToPath(new URL(`./harness/${file}`, import.meta.url))
export default defineConfig(async (env) => {
  const real = await (base as unknown as (e: typeof env) => Promise<Record<string, unknown>>)(env)
  return {
    ...real,
    plugins: ((real.plugins as PluginOption[]) ?? []).filter(
      (p) =>
        !(
          p &&
          typeof p === 'object' &&
          'name' in p &&
          /pwa|mobile-entry-redirect/.test(String(p.name))
        ),
    ),
    root: fileURLToPath(new URL('.', import.meta.url)),
    resolve: {
      ...(real.resolve as Record<string, unknown>),
      alias: [
        { find: '@podium/client-core/react', replacement: fixture('settings-frame-core.ts') },
        { find: /^.*\/store-worklist-pool$/, replacement: fixture('settings-frame-store.ts') },
        { find: /^.*\/stable-access$/, replacement: fixture('settings-frame-store.ts') },
        { find: /^.*\/use-feature$/, replacement: fixture('settings-frame-store.ts') },
        { find: /^.*\/update-status$/, replacement: fixture('settings-frame-store.ts') },
        ...Object.entries((real.resolve as { alias: Record<string, string> }).alias ?? {}).map(
          ([find, replacement]) => ({ find, replacement }),
        ),
      ],
    },
    server: { port: 55652, strictPort: true, fs: { strict: false } },
  }
})
