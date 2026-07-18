import { defineConfig } from 'vitest/config'
import { nodeTestExclude, sharedVitestConfig } from './vitest.config'

const integrationTests = [
  'tests/e2e/**/*.test.{ts,tsx}',
  '**/*e2e*.test.{ts,tsx}',
  '**/*.integration.{test,spec}.{ts,tsx}',
  '**/*.pty.test.{ts,tsx}',
  'packages/agent-bridge/test/pty-behavior/pty-behavior.vitest.test.ts',
  'packages/agent-bridge/test/session.test.ts',
  'packages/agent-bridge/src/pty/node-pty-backend.test.ts',
  'packages/agent-bridge/src/abduco.test.ts',
  'packages/agent-bridge/src/abduco-bin.test.ts',
  'packages/agent-bridge/src/tmux.test.ts',
  'apps/daemon/src/daemon.test.ts',
  'apps/daemon/src/memory-breakdown.test.ts',
  'scripts/redeploy-wait.test.ts',
  // Heavy process/PTY/server-boot suites excluded from the unit lane
  // (vitest.unit.config.ts keeps the mirror of this list).
  'apps/cli/src/podium-update.test.ts',
  'apps/daemon/src/durable-headless.test.ts',
  'apps/server/src/sync-e2e.test.ts',
  'apps/server/src/server.plugins.test.ts',
  'apps/server/src/server.port-in-use.test.ts',
  'apps/server/src/upstream-auth-e2e.test.ts',
  'apps/server/src/upstream-e2e.test.ts',
  'apps/server/src/wsServer.version-gate.test.ts',
]

/** Deterministic native/process integration scope. Resource flakes retry here only. */
export default defineConfig({
  resolve: sharedVitestConfig.resolve,
  test: {
    name: 'node',
    ...sharedVitestConfig.test,
    passWithNoTests: true,
    include: integrationTests,
    exclude: [
      ...nodeTestExclude,
      '**/*.smoke.test.{ts,tsx}',
      'scripts/loop-split-load.integration.test.ts',
    ],
    retry: 1,
    testTimeout: 20_000,
  },
})
