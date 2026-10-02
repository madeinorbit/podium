/** Build the prototype entry at the EXISTING collector's URL; no collector fork. */
import { mkdirSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'
import config from './pool-memory.vite'

export default {
  ...config,
  plugins: [
    ...config.plugins!,
    {
      name: 'existing-memory-collector-url',
      enforce: 'post' as const,
      writeBundle() {
        const build = resolve('.artifacts/pool-memory/build')
        mkdirSync(resolve(build, 'test'), { recursive: true })
        renameSync(
          resolve(build, 'harness/per-row-memory.browser.html'),
          resolve(build, 'test/pool-memory.browser.html'),
        )
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
