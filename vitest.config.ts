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
  // apps/mobile, like apps/web, brings its own config: React Native ships
  // Flow-typed source this lane cannot parse, so its suites need the
  // react-native -> react-native-web alias and the expo-sqlite stub that
  // `apps/mobile/vitest.config.ts` supplies. Without this line the node lane
  // collects them and dies in the transform (POD-1220).
  'apps/mobile/**',
]

// Keep forked test runs below the shared development host resource ceiling by default.
// Dedicated CI/test hosts can set PODIUM_TEST_WORKERS=auto or a positive integer.
export const DEFAULT_TEST_WORKERS = 2

export function resolveTestWorkerLimit(
  value = process.env.PODIUM_TEST_WORKERS,
): number | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return DEFAULT_TEST_WORKERS
  if (normalized === 'auto') return undefined
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error('PODIUM_TEST_WORKERS must be a positive integer or "auto"')
  }
  const workers = Number(normalized)
  if (!Number.isSafeInteger(workers)) {
    throw new Error('PODIUM_TEST_WORKERS is too large')
  }
  return workers
}

const configuredTestWorkers = resolveTestWorkerLimit()

export const sharedTestWorkerLimits = {
  fileParallelism: true,
  minWorkers: 1,
  ...(configuredTestWorkers === undefined ? {} : { maxWorkers: configuredTestWorkers }),
} as const

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
      // ANCHORED as of POD-335, and the anchoring is not defensive — it was a live
      // break. `@podium/harness` gained the `./metadata` open entrypoint, and the
      // bare STRING form here prefix-matched it and rewrote
      // '@podium/harness/metadata' to '<index.ts>/metadata'. 99 apps/server suites
      // failed to import with "Cannot find package", which is the exact hazard the
      // model/sync entries above already anchor against.
      // ANCHORED for the same reason harness is, and for the same live hazard:
      // `@podium/harness` exposes open subpath entrypoints (`./driver`,
      // `./driver/host`, `./store`, …), so a bare string alias would rewrite
      // them to '<index.ts>/…'. Each entry below is anchored; the deep family
      // path the daemon's composer-sync reaches is anchored too.
      {
        find: /^@podium\/harness\/browser$/,
        replacement: fileURLToPath(
          new URL('./packages/harness/src/browser.ts', import.meta.url),
        ),
      },
      {
        find: /^@podium\/harness\/driver$/,
        replacement: fileURLToPath(
          new URL('./packages/harness/src/driver.ts', import.meta.url),
        ),
      },
      {
        find: /^@podium\/harness\/driver\/host$/,
        replacement: fileURLToPath(
          new URL('./packages/harness/src/driver/host.ts', import.meta.url),
        ),
      },
      {
        find: /^@podium\/harness\/driver\/testing$/,
        replacement: fileURLToPath(
          new URL('./packages/harness/src/driver/testing/index.ts', import.meta.url),
        ),
      },
      {
        find: /^@podium\/harness\/driver\/families\/terminal\/composer-sync$/,
        replacement: fileURLToPath(
          new URL(
            './packages/harness/src/driver/families/terminal/composer-sync.ts',
            import.meta.url,
          ),
        ),
      },
      // Hook instrumentation sections (POD-4472): the family mechanism and the
      // per-harness sections the daemon installs/decodes through. Same
      // anchored shape as every entry above: without one the subpath falls
      // through to node_modules resolution and the main checkout's copy.
      {
        find: /^@podium\/harness\/driver\/families\/terminal\/instrumentation$/,
        replacement: fileURLToPath(
          new URL(
            './packages/harness/src/driver/families/terminal/instrumentation.ts',
            import.meta.url,
          ),
        ),
      },
      {
        find: /^@podium\/harness\/driver\/families\/terminal\/loopback-listen$/,
        replacement: fileURLToPath(
          new URL(
            './packages/harness/src/driver/families/terminal/loopback-listen.ts',
            import.meta.url,
          ),
        ),
      },
      {
        find: /^@podium\/harness\/adapters\/shared\/hook-fields$/,
        replacement: fileURLToPath(
          new URL('./packages/harness/src/adapters/shared/hook-fields.ts', import.meta.url),
        ),
      },
      // The shared composer byte vocabulary (POD-4477): daemon composer tests
      // pin clear/type sequences against these named constants. Same anchored
      // shape as every entry above.
      {
        find: /^@podium\/harness\/adapters\/shared\/composer$/,
        replacement: fileURLToPath(
          new URL('./packages/harness/src/adapters/shared/composer.ts', import.meta.url),
        ),
      },
      {
        find: /^@podium\/harness\/adapters\/codex\/instrumentation$/,
        replacement: fileURLToPath(
          new URL('./packages/harness/src/adapters/codex/instrumentation.ts', import.meta.url),
        ),
      },
      {
        find: /^@podium\/harness\/adapters\/grok\/instrumentation$/,
        replacement: fileURLToPath(
          new URL('./packages/harness/src/adapters/grok/instrumentation.ts', import.meta.url),
        ),
      },
      {
        find: /^@podium\/harness\/adapters\/claude-code\/instrumentation$/,
        replacement: fileURLToPath(
          new URL(
            './packages/harness/src/adapters/claude-code/instrumentation.ts',
            import.meta.url),
          ),
      },
      // Fixture harness (POD-4474): the test-only seventh manifest the
      // server→daemon route test registers. Same anchored shape as every
      // entry above: without it the subpath falls through to node_modules
      // resolution and the unbuilt dist.
      {
        find: /^@podium\/harness\/adapters\/fixture$/,
        replacement: fileURLToPath(
          new URL('./packages/harness/src/adapters/fixture/index.ts', import.meta.url),
        ),
      },
      {
        find: /^@podium\/harness\/store$/,
        replacement: fileURLToPath(
          new URL('./packages/harness/src/store.ts', import.meta.url),
        ),
      },
      {
        find: /^@podium\/harness$/,
        replacement: fileURLToPath(new URL('./packages/harness/src/index.ts', import.meta.url)),
      },
      {
        find: /^@podium\/harness\/metadata$/,
        replacement: fileURLToPath(new URL('./packages/harness/src/metadata.ts', import.meta.url)),
      },
      // Served/bundled wire descriptors (POD-4529): the only browser-entry
      // import outside web/mobile — the server reads provider labels off the
      // served report over this bundled fallback. Same anchored shape as
      // every entry above: without it the subpath falls through to
      // node_modules resolution and the unbuilt dist.
      {
        find: /^@podium\/harness\/browser$/,
        replacement: fileURLToPath(new URL('./packages/harness/src/browser.ts', import.meta.url)),
      },
      // The machine-inventory entry the daemon reads credentials, quota and
      // usage through (issue 3.3). Same anchored shape as every entry above:
      // without it the subpath falls through to node_modules resolution and
      // the unbuilt dist.
      {
        find: /^@podium\/harness\/inventory$/,
        replacement: fileURLToPath(
          new URL('./packages/harness/src/inventory.ts', import.meta.url),
        ),
      },
      // Anchored RegExp, not a bare string: model is the L0 root every lane resolves,
      // and the prefix-match hazard described above is not worth re-learning if it
      // ever grows a subpath export.
      {
        find: /^@podium\/model$/,
        replacement: fileURLToPath(new URL('./packages/model/src/index.ts', import.meta.url)),
      },
      {
        find: /^@podium\/protocol$/,
        replacement: fileURLToPath(new URL('./packages/protocol/src/index.ts', import.meta.url)),
      },
      {
        find: /^@podium\/protocol\/daemon$/,
        replacement: fileURLToPath(new URL('./packages/protocol/src/daemon.ts', import.meta.url)),
      },
      // ANCHORED, and added by POD-736 after it cost a real defect. `@podium/sync`
      // was absent from this list, so a `scripts/` test importing it took the
      // walk-up described above and resolved the MAIN checkout's copy — which
      // predates POD-1077 and exports no `DEVICE_GRADE_PRINCIPAL`.
      //
      // WHAT THAT ACTUALLY DID, because "an import resolved elsewhere" sounds
      // survivable: `audit-serving-path.test.ts` served a v1 peer with
      // `principal === undefined` and PASSED, because nothing downstream read the
      // principal. It was a green test certifying a serving path admitted with no
      // principal at all — the run's dominant defect, arriving through the module
      // resolver rather than through a fixture. POD-736's `perfPrincipal` reads
      // `principal.kind` and turned it into a crash, which is how it was found.
      //
      // Anchored rather than a bare string: sync exposes ./replica, ./outbox,
      // ./span and three ./adapters/* subpaths, and a prefix match would rewrite
      // '@podium/sync/span' to '<index.ts>/span'. Subpath specifiers therefore
      // still resolve through the exports map; no test imports one today, and the
      // day one does it wants its own anchored entry rather than a prefix.
      {
        find: /^@podium\/sync$/,
        replacement: fileURLToPath(new URL('./packages/sync/src/index.ts', import.meta.url)),
      },
      // Anchored pair for the renamed process package (P2a, in packages/pty,
      // with ./pty ./durable ./screen doors).
      // Bare-string form would prefix-match the subpaths and rewrite
      // '@podium/process/durable' to '<index.ts>/durable' — the exact hazard
      // the runtime entries above anchor against. `$1` keeps the subpath.
      {
        find: /^@podium\/process$/,
        replacement: fileURLToPath(new URL('./packages/pty/src/index.ts', import.meta.url)),
      },
      {
        find: /^@podium\/process\/(.*)$/,
        replacement: `${fileURLToPath(new URL('./packages/pty/src/', import.meta.url))}$1`,
      },
      // Leaving runtime to the exports map resolved it by walking *up* the filesystem
      // out of the checkout, and a walk-up can land in a sibling checkout's
      // node_modules. (The original reason was that scripts/ owned no @podium
      // symlink because it was not a workspace package. POD-1122 made it one, so
      // that premise is now FALSE — scripts/ does own its own node_modules/@podium.
      // The anchoring below is still what makes this safe, and the hazard it
      // guards against is unchanged for any path outside a workspace package.)
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
    // The third one is POD-523's pre-migrated store fixture: ordinary apps/server
    // test files clone a current-schema database instead of replaying all 54
    // migrations. It is a setupFile because the decision is per test FILE and has to
    // be made before the file is imported. No-op for every other package.
    setupFiles: [
      './test-hermetic-env.ts',
      './test-hermetic-vitest-hooks.ts',
      './test-pre-migrated-store.ts',
    ],
    // The other half of that fixture: build the schema image once per lane, in the
    // main process, so no fork ever loads the migration chain's module graph. An
    // ABSOLUTE path — package lanes and apps/web/apps/mobile resolve this config's
    // options from their own roots, and a relative entry would miss.
    globalSetup: [fileURLToPath(new URL('./test-pre-migrated-schema.ts', import.meta.url))],
    // The suite runs under the Bun runtime (`bun --bun vitest`) so tests exercise
    // the same bun:sqlite driver the shipped binary does (POD-552 / SP-3f93). Bun's
    // worker_threads support is incomplete for vitest's `threads` pool, so pin
    // `forks` (a child process per file) — the default, made explicit as a guard.
    pool: 'forks' as const,
    // A broad suite creates one Bun/Vite module graph per fork. Keep the default
    // lanes inside the host memory budget instead of using the CPU-count default.
    // POD-1678: the rewrite exposed the old fan-out as a host-wide OOM risk.
    ...sharedTestWorkerLimits,
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
    // right environment per suite: everything except apps/web and apps/mobile runs
    // under node; each of those needs happy-dom and its own aliases, so each brings
    // its own config.
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
      './apps/mobile/vitest.config.ts',
    ],
  },
})
