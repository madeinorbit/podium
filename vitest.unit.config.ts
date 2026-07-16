import { defineConfig } from 'vitest/config'
import { nodeTestExclude, sharedVitestConfig } from './vitest.config'

/**
 * Unit-test scope (`bun run test:unit`) — the fast hermetic default, run on every PR
 * (.github/workflows/ci.yml) and in the default `bun run test`.
 *
 * Convention: anything that talks to the real world stays OUT of the unit run and lives
 * in the integration lane (`bun run test:integration`) or the real-agent smoke lane
 * (`bun run test:smoke:agents`, gated on PODIUM_REAL_CLI=1):
 *   - tests/e2e/**            → full-stack e2e (real server + daemon + abduco + playwright)
 *   - *e2e*.test.ts           → boots a live in-process server on a real port
 *   - *.integration.*         → spawns real processes / systemd scopes
 *   - *.smoke.test.ts         → requires a real agent binary (claude/codex); opt-in only
 *   - *.pty.test.ts, pty-behavior/, session.test, node-pty-backend.test, abduco*.test
 *                             → spawn real PTYs (node-pty native addon) or build/run abduco.
 *                               CI installs with --ignore-scripts, so node-pty's native
 *                               addon is never built there and any real spawn would throw.
 *   - *.bun.test.ts           → `bun test` only (import bun:test); excluded in the base config
 *
 * Drift guard: scripts/test-configuration.test.ts asserts the lane invariants.
 */
export default defineConfig({
  resolve: sharedVitestConfig.resolve,
  test: {
    name: 'node',
    ...sharedVitestConfig.test,
    passWithNoTests: true,
    // Hermetic lane: a flaky unit test is a bug, not weather. No retries.
    retry: 0,
    exclude: [
      ...nodeTestExclude,
      'tests/e2e/**',
      '**/*e2e*.test.{ts,tsx}',
      '**/*.integration.*',
      '**/*.smoke.test.{ts,tsx}',
      '**/*.pty.test.{ts,tsx}',
      'packages/agent-bridge/test/pty-behavior/**',
      'packages/agent-bridge/test/session.test.ts',
      'packages/agent-bridge/src/pty/node-pty-backend.test.ts',
      'packages/agent-bridge/src/abduco.test.ts',
      'packages/agent-bridge/src/abduco-bin.test.ts',
      'packages/agent-bridge/src/tmux.test.ts',
      // Boots a real daemon and spawns PTY-backed fixture agents per test.
      'apps/daemon/src/daemon.test.ts',
      // Spawn real child processes (bun install/typecheck; memory sampling).
      'scripts/redeploy-wait.test.ts',
      'apps/daemon/src/memory-breakdown.test.ts',
      // Heavy process/PTY/server-boot suites — run in the integration lane instead
      // (mirrored in vitest.integration.config.ts's include list).
      'apps/cli/src/podium-update.test.ts',
      'apps/daemon/src/durable-headless.test.ts',
      'apps/server/src/sync-e2e.test.ts',
      'apps/server/src/server.plugins.test.ts',
      'apps/server/src/server.port-in-use.test.ts',
      'apps/server/src/upstream-auth-e2e.test.ts',
      'apps/server/src/upstream-e2e.test.ts',
      'apps/server/src/wsServer.version-gate.test.ts',
    ],
  },
})
