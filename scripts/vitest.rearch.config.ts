import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { sharedVitestConfig } from '../vitest.config'

/** Rewrite migration guardrails are intentionally opt-in. They repeatedly scan
 * the complete repository and are irrelevant to ordinary product changes. */
export default defineConfig({
  root: fileURLToPath(new URL('../', import.meta.url)),
  resolve: sharedVitestConfig.resolve,
  test: {
    ...sharedVitestConfig.test,
    include: ['scripts/rearch-audit.test.ts'],
    passWithNoTests: false,
    retry: 0,
    maxWorkers: 1,
  },
})
