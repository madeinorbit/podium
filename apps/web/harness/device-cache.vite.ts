import { resolve } from 'node:path'
import { standardDecorators } from '../../../scripts/vite-standard-decorators'
import { defineConfig } from '../node_modules/vite/dist/node/index.js'

export default defineConfig({
  root: resolve('apps/web/harness'),
  plugins: [standardDecorators()],
  resolve: { conditions: ['@podium/source'], dedupe: ['react', 'react-dom'] },
  esbuild: { jsx: 'automatic' },
  build: {
    outDir: resolve('.artifacts/7095/cache-build'),
    emptyOutDir: true,
    minify: true,
    target: 'es2022',
    rollupOptions: {
      input: process.env['PODIUM_MEASUREMENT_FEED_ONLY']
        ? resolve('apps/web/harness/device-feed.html')
        : [
            resolve('apps/web/harness/device-cache.html'),
            resolve('apps/web/harness/device-feed.html'),
          ],
    },
  },
})
