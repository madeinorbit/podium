/** Build the prototype entry at the EXISTING collector's URL; no collector fork. */
import { resolve } from 'node:path'
import config from './pool-memory.vite'

export default {
  ...config,
  resolve: {
    ...config.resolve,
    alias: {
      ...config.resolve!.alias,
      // The hand arm exposes a lazy native mount too. Use its established web
      // harness alias; the memory fixture never mounts or loads that chunk.
      'react-native': resolve(
        'packages/worklist-proto/node_modules/react-native-web/dist/index.js',
      ),
    },
  },
  plugins: [
    ...config.plugins!,
    {
      name: 'existing-memory-collector-url',
      enforce: 'post' as const,
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
      preserveEntrySignatures: 'allow-extension' as const,
      output: {
        strictExecutionOrder: true,
        codeSplitting: {
          // Removal cuts select closures by script. Shared React/runtime
          // dependencies must remain outside the prototype's named scripts.
          includeDependenciesRecursively: false,
          groups: [
            {
              name(id: string) {
                if (
                  id.endsWith('/client-graph/src/shared/row-source.ts') ||
                  id.endsWith('/client-graph/src/shared/engine-locals.ts')
                )
                  return 'prototype-feed'
                if (id.includes('/worklist-proto/arms/hand/')) return 'hand-pool'
                if (id.includes('/worklist-proto/arms/lean/')) return 'lean-pool'
              },
            },
          ],
        },
      },
    },
  },
}
