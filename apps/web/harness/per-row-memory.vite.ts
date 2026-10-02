/** Build the prototype entry at the EXISTING collector's URL; no collector fork. */
import { resolve } from 'node:path'
import config from './pool-memory.vite'

export default {
  ...config,
  plugins: [
    ...config.plugins!,
    {
      name: 'existing-memory-collector-url',
      generateBundle(_options: unknown, bundle: Record<string, { fileName: string }>) {
        const entry = bundle['harness/per-row-memory.browser.html']!
        delete bundle[entry.fileName]
        entry.fileName = 'test/pool-memory.browser.html'
        bundle[entry.fileName] = entry
      },
    },
  ],
  build: {
    ...config.build,
    rollupOptions: {
      input: resolve('apps/web/harness/per-row-memory.browser.html'),
      output: {
        manualChunks(id: string) {
          if (id.endsWith('/client-graph/src/shared/row-source.ts') || id.endsWith('/client-graph/src/shared/engine-locals.ts')) return 'prototype-feed'
          if (id.includes('/worklist-proto/arms/hand/')) return 'hand-pool'
          if (id.includes('/worklist-proto/arms/lean/')) return 'lean-pool'
        },
      },
    },
  },
}
