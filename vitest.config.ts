import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
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
    passWithNoTests: true,
    // Don't run tests inside nested agent-harness worktrees (e.g. .claude/worktrees/*).
    // `*.bun.test.ts` files are for `bun test` only (they import `bun:test`); vitest
    // must never collect them.
    exclude: [...configDefaults.exclude, '**/.claude/**', '**/.claire/**', '**/*.bun.test.ts'],
  },
})
