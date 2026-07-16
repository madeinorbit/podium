import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

/** Node-project exclude list shared by the default, unit, integration, and smoke lanes.
 * Don't run tests inside nested agent-harness worktrees (e.g. .claude/worktrees/*).
 * `*.bun.test.ts` files are for `bun test` only (they import `bun:test`); vitest
 * must never collect them. apps/web belongs to the web project (happy-dom). */
export const nodeTestExclude = [
  ...configDefaults.exclude,
  '**/.claude/**',
  '**/.claire/**',
  '**/.worktrees/**',
  '**/*.bun.test.ts',
  'apps/web/**',
]

/** Shared resolve (workspace aliases + @podium/source condition) and common node test
 * options, spread into every lane config (vitest.unit/integration/agent-smoke). */
export const sharedVitestConfig = {
  resolve: {
    alias: {
      // NOTE: do NOT alias '@podium/runtime' — Vite string aliases match by prefix, which
      // would rewrite the '@podium/runtime/sqlite' subpath import (in apps/server/store.ts)
      // to '<index.ts>/sqlite' and break it. Bare '@podium/runtime' resolves fine via the
      // workspace exports map; scripts/cli.ts imports core by relative path for the
      // bun-compile, so no alias is needed.
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
      '@podium/agent-bridge': fileURLToPath(
        new URL('./packages/agent-bridge/src/index.ts', import.meta.url),
      ),
      '@podium/domain': fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)),
      '@podium/protocol': fileURLToPath(
        new URL('./packages/protocol/src/index.ts', import.meta.url),
      ),
      '@podium/transcript': fileURLToPath(
        new URL('./packages/transcript/src/index.ts', import.meta.url),
      ),
      '@podium/terminal-client': fileURLToPath(
        new URL('./packages/terminal-client/src/index.ts', import.meta.url),
      ),
    },
    conditions: ['@podium/source'],
  },
  test: {
    // Strip the ambient Podium agent-session env before every test file so a suite
    // launched from inside a live session can't touch/be hijacked by the live instance
    // (POD-555 [spec:SP-b85a]). `bun test` gets the same via bunfig.toml [test].preload.
    setupFiles: ['./test-hermetic-env.ts'],
    // The suite runs under the Bun runtime (`bun --bun vitest`) so tests exercise
    // the same bun:sqlite driver the shipped binary does (POD-552 / SP-3f93). Bun's
    // worker_threads support is incomplete for vitest's `threads` pool, so pin
    // `forks` (a child process per file) — the default, made explicit as a guard.
    pool: 'forks' as const,
    // Shared-vCPU hosts make sqlite-heavy tests (migrations) overrun the
    // 5s default; 20s keeps them honest without flaking on CPU steal.
    testTimeout: 20_000,
  },
}

export default defineConfig({
  resolve: sharedVitestConfig.resolve,
  test: {
    passWithNoTests: true,
    // Two projects so one root `vitest run` covers the whole workspace with the
    // right environment per suite: everything except apps/web runs under node;
    // apps/web needs happy-dom and its own aliases, so it brings its own config.
    // No retry here — retry policy belongs to the lanes (unit 0, integration 1).
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          ...sharedVitestConfig.test,
          exclude: nodeTestExclude,
        },
      },
      './apps/web/vitest.config.ts',
    ],
  },
})
