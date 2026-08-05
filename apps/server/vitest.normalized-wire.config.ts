import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { sharedVitestConfig } from '../../vitest.config'
import { normalizedWireTests } from '../../vitest.unit.config'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

/**
 * The server's normalized-wire pair is intentionally serialized after its regular unit
 * files. Keep it in the server package task so it is cached with the owner while retaining
 * the root lane's one-worker load guard.
 */
export default defineConfig({
  root: repositoryRoot,
  resolve: sharedVitestConfig.resolve,
  test: {
    ...sharedVitestConfig.test,
    name: 'normalized-wire',
    include: normalizedWireTests,
    passWithNoTests: false,
    retry: 0,
    fileParallelism: false,
    maxWorkers: 1,
  },
})
