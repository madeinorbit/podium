import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config'

/**
 * Unit-test scope (`bun run test:unit`) — what CI runs on every PR (.github/workflows/ci.yml).
 *
 * Convention: anything that talks to the real world stays OUT of the unit run and lives
 * behind one of these markers instead (run via `bun run test` locally, where the native
 * toolchain + agent binaries exist):
 *   - tests/e2e/**            → full-stack e2e (real server + daemon + abduco + playwright)
 *   - *e2e*.test.ts           → boots a live in-process server on a real port
 *   - *.integration.*         → spawns real processes / systemd scopes
 *   - *.smoke.test.ts         → requires a real agent binary (claude/codex); self-skipping
 *   - *.pty.test.ts, pty-behavior/, session.test, node-pty-backend.test, abduco*.test
 *                             → spawn real PTYs (node-pty native addon) or build/run abduco.
 *                               CI installs with --ignore-scripts, so node-pty's native
 *                               addon is never built there and any real spawn would throw.
 *   - *.bun.test.ts           → `bun test` only (import bun:test); excluded in the base config
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      exclude: [
        // apps/web needs happy-dom + its own aliases; it runs via its own config
        // (`bun run --cwd apps/web test:unit`) as a separate CI step.
        'apps/web/**',
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
      ],
    },
  }),
)
