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
// again. It had to be a walk: this config appears in no roster anywhere, so the
// hand-written one in scripts/test-configuration.test.ts never asked it anything.
const sharedSetupFiles = sharedVitestConfig.test.setupFiles.map((file) =>
  fileURLToPath(new URL(`../../${file}`, import.meta.url)),
)

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    conditions: ['@podium/source'],
    dedupe: ['react', 'react-dom'],
  },
  test: {
    setupFiles: sharedSetupFiles,
    environment: 'happy-dom',
    include: ['src/perf/tuck-fanout.probe.tsx'],
    reporters: ['verbose'],
    retry: 0,
    fileParallelism: false,
    maxWorkers: 1,
  },
})
