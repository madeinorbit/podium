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
    // Array form (not the object map): it takes anchored RegExp `find`s, which is the
    // only way to alias a package that exposes subpaths. A *string* alias matches by
    // prefix, so '@podium/runtime' would rewrite the '@podium/runtime/sqlite' subpath
    // import to '<index.ts>/sqlite' — that hazard is why runtime went unaliased.
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./apps/web/src', import.meta.url)) },
      {
        find: '@podium/agent-bridge',
        replacement: fileURLToPath(
          new URL('./packages/agent-bridge/src/index.ts', import.meta.url),
        ),
      },
      {
        find: '@podium/composer',
        replacement: fileURLToPath(new URL('./packages/composer/src/index.ts', import.meta.url)),
      },
      // Anchored RegExp, not a bare string: model is the L0 root every lane resolves,
      // and the prefix-match hazard described above is not worth re-learning if it
      // ever grows a subpath export.
      {
        find: /^@podium\/model$/,
        replacement: fileURLToPath(new URL('./packages/model/src/index.ts', import.meta.url)),
      },
      {
        find: '@podium/protocol',
        replacement: fileURLToPath(new URL('./packages/protocol/src/index.ts', import.meta.url)),
      },
      // Leaving runtime to the exports map resolved it by walking *up* the filesystem
      // out of the checkout: scripts/ is not a workspace package, so it owns no
      // @podium symlink, and a walk-up can land in a sibling checkout's node_modules.
      // Two copies of a module = two module-scoped WeakMaps, and bunSqliteClient()
      // then can't recognise a db the other copy opened — it returns undefined and the
      // migrator blames the runtime [POD-746]. Anchor every lane to THIS checkout's
      // source; `$1` keeps the subpath, and vite resolves the dir/index or the .ts file.
      {
        find: /^@podium\/runtime$/,
        replacement: fileURLToPath(new URL('./packages/runtime/src/index.ts', import.meta.url)),
      },
      {
        find: /^@podium\/runtime\/(.*)$/,
        replacement: `${fileURLToPath(new URL('./packages/runtime/src/', import.meta.url))}$1`,
      },
      // NOTE: no '@podium/telemetry' alias. Same subpath shape as runtime, and the hazard
      // above is real — so this is a CHECKED decision, not an oversight, and it rests on two
      // things that are both true today [POD-746, spec:SP-f933]:
      //   1. the seam is unreachable — nothing outside a workspace package imports it
      //      (no @podium/telemetry import in scripts/ or tests/), so nothing walks up; and
      //   2. duplication would be harmless — telemetry holds no MODULE-scoped identity
      //      state. Its only mutable state is a private field of TelemetryEmitter, which
      //      callers construct: per instance, not per module copy. Runtime broke only
      //      because a module-scoped WeakMap made identity load-bearing.
      // EITHER half failing brings the hazard back: give telemetry a module-scoped
      // WeakMap/Map/registry, or import it from scripts/, and it needs the anchor above.
      {
        find: '@podium/transcript',
        replacement: fileURLToPath(new URL('./packages/transcript/src/index.ts', import.meta.url)),
      },
      {
        find: '@podium/terminal-client',
        replacement: fileURLToPath(
          new URL('./packages/terminal-client/src/index.ts', import.meta.url),
        ),
      },
    ],
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
