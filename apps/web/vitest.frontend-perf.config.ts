import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { sharedVitestConfig } from '../../vitest.config'

// The hermetic pair (plus POD-523's pre-migrated store fixture), resolved to ABSOLUTE
// paths exactly as apps/web/vitest.config.ts does: this config sets no `root`, so a
// relative './test-hermetic-env.ts' would resolve against apps/web/ and name a file
// that does not exist. Without these, every file in this lane runs with the ambient
// operator environment and stateDir() resolves the LIVE ~/.podium — which is how a
// test process comes to open, back up and migrate the operator's running database.
// scripts/hermetic-lane-audit.test.ts walks the tree and fails if this is dropped
// again; the hand-written roster in scripts/test-configuration.test.ts imports this
// very file and never noticed.
const sharedSetupFiles = sharedVitestConfig.test.setupFiles.map((file) =>
  fileURLToPath(new URL(`../../${file}`, import.meta.url)),
)

/**
 * Hermetic large-state frontend performance lane (POD-999).
 *
 * This is deliberately separate from the default web unit suite: it renders a
 * Ludovico-scale Tasks board and exercises whole-replica/derivation paths,
 * including the real kernel-store render harness. CI runs it explicitly, with
 * one worker and no retries so its operation budgets remain deterministic and
 * failures cannot be hidden as timing weather.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    conditions: ['@podium/source'],
    dedupe: ['react', 'react-dom'],
  },
  test: {
    setupFiles: sharedSetupFiles,
    environment: 'happy-dom',
    include: [
      'src/perf/large-state.frontend-perf.tsx',
      'src/perf/responsive-filtering.frontend-perf.tsx',
      'src/perf/scoped-session-render.test.tsx',
      'src/features/issues/IssuesKanban.test.tsx',
    ],
    reporters: ['verbose'],
    passWithNoTests: false,
    retry: 0,
    fileParallelism: false,
    maxWorkers: 1,
  },
})
