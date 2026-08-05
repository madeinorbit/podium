import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { sharedVitestConfig } from '../vitest.config'
import { unitTestExclude } from '../vitest.unit.config'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

/**
 * Build the unit-scope config used by a workspace package's own test script.
 * The config file lives in the package so Vitest discovers it from that package's cwd,
 * while the root and shared options keep resolution, setup, and exclusions identical to
 * the root unit lane.
 */
export const createPackageVitestConfig = (workspacePath: string) =>
  defineConfig({
    root: repositoryRoot,
    resolve: sharedVitestConfig.resolve,
    test: {
      ...sharedVitestConfig.test,
      include: [workspacePath + '/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
      exclude: unitTestExclude,
      passWithNoTests: true,
      retry: 0,
    },
  })
