import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import base from './vite.config'

export default defineConfig(async (env) => {
  const config = await (base as (e: typeof env) => Promise<Record<string, unknown>>)(env)
  return {
    ...config,
    root: fileURLToPath(new URL('.', import.meta.url)),
    build: {
      ...(config.build as object),
      outDir: fileURLToPath(new URL('../../.artifacts/offline-routes/build', import.meta.url)),
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: {
        input: [
          fileURLToPath(new URL('./index.html', import.meta.url)),
          fileURLToPath(new URL('./harness/offline-routes.html', import.meta.url)),
        ],
      },
    },
  }
})
