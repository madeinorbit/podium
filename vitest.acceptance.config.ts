import { defineConfig } from 'vitest/config'
import { nodeTestExclude, sharedVitestConfig } from './vitest.config'

/** Resource-isolated performance acceptance. Never share workers with the
 * process-heavy integration files whose runqueue contention it measures. */
export default defineConfig({
  resolve: sharedVitestConfig.resolve,
  test: {
    name: 'acceptance',
    ...sharedVitestConfig.test,
    passWithNoTests: false,
    include: ['scripts/loop-split-load.integration.test.ts'],
    exclude: nodeTestExclude,
    retry: 0,
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
  },
})
