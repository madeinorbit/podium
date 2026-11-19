import { fileURLToPath } from 'node:url'
import { mergeConfig } from 'vitest/config'
import { createPackageVitestConfig } from './package-vitest-config'

export default mergeConfig(createPackageVitestConfig('scripts'), {
  test: {
    setupFiles: [fileURLToPath(new URL('./test-repository-root.ts', import.meta.url))],
    // The migration/rewrite audit scans the whole repository and its CLI cases
    // scan it again in child processes. It is an explicit rewrite-only lane,
    // never part of the normal package gate.
    exclude: ['scripts/rearch-audit.test.ts'],
  },
})
