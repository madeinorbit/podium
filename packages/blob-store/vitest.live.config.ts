import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { sharedVitestConfig } from '../../vitest.config'

/**
 * Explicit, credentialed lane: the blob store contract against a real
 * S3-compatible bucket named by PODIUM_FILE_STORAGE_* (POD-6963 F2). Never part
 * of the default gate; `*.live.test.ts` is excluded from every unit lane.
 */
export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  resolve: sharedVitestConfig.resolve,
  test: {
    ...sharedVitestConfig.test,
    name: 'blob-store-live',
    include: ['packages/blob-store/src/s3.live.test.ts'],
    exclude: [],
    passWithNoTests: false,
    retry: 0,
    fileParallelism: false,
    maxWorkers: 1,
    // Real network round trips; one contract test makes a few dozen.
    testTimeout: 60_000,
  },
})
