import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { sharedVitestConfig } from '../../vitest.config'

/** Explicit heavy lane for the deliberately quadratic IndexedDB scaling probe. */
export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  resolve: sharedVitestConfig.resolve,
  test: {
    ...sharedVitestConfig.test,
    name: 'sync-perf',
    include: ['packages/sync/src/adapters/indexeddb/apply-scaling.bench.test.ts'],
    exclude: [],
    passWithNoTests: false,
    retry: 0,
    fileParallelism: false,
    maxWorkers: 1,
  },
})
