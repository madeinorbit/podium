import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { standardDecorators } from '../../scripts/vite-standard-decorators'
import { sharedVitestConfig } from '../../vitest.config'
import { unitTestExclude } from '../../vitest.unit.config'
import { productWorkMeter } from './harness/src/perf/vite'

// Package-local vitest config, following the apps/web happy-dom pattern
// (apps/web/vitest.config.ts). Resolution, setup and exclusions stay identical
// to the root unit lane. `test:file`, the named worklist lane and the
// package sweep use this same config, including the measurement plugins.
const sharedSetupFiles = sharedVitestConfig.test.setupFiles.map((file) =>
  fileURLToPath(new URL(`../../${file}`, import.meta.url)),
)

export default defineConfig({
  plugins: [productWorkMeter(), standardDecorators()],
  resolve: sharedVitestConfig.resolve,
  test: {
    ...sharedVitestConfig.test,
    setupFiles: sharedSetupFiles,
    environment: 'happy-dom',
    include: [
      'shared/**/*.test.{ts,tsx}',
      'harness/**/*.test.{ts,tsx}',
      'diagnostics/**/*.test.{ts,tsx}',
      'product/**/*.test.{ts,tsx}',
    ],
    exclude: unitTestExclude,
    passWithNoTests: true,
    retry: 0,
  },
})
