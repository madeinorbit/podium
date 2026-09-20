import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { sharedVitestConfig } from '../../vitest.config'
import { unitTestExclude } from '../../vitest.unit.config'

// Package-local vitest config, following the apps/web happy-dom pattern
// (apps/web/vitest.config.ts): the arms mount real row components, so this
// lane runs under happy-dom. Resolution, setup and exclusions stay identical
// to the root unit lane. `test:file` routes package files to the root node
// lane instead; this config is for the package's own `test` script.
const sharedSetupFiles = sharedVitestConfig.test.setupFiles.map((file) =>
  fileURLToPath(new URL(`../../${file}`, import.meta.url)),
)

export default defineConfig({
  resolve: sharedVitestConfig.resolve,
  test: {
    ...sharedVitestConfig.test,
    setupFiles: sharedSetupFiles,
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}', 'shared/**/*.test.{ts,tsx}', 'arms/**/*.test.{ts,tsx}', 'harness/**/*.test.{ts,tsx}'],
    exclude: unitTestExclude,
    passWithNoTests: true,
    retry: 0,
  },
})
