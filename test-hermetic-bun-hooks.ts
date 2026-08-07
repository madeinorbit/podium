import { afterEach, beforeEach } from 'bun:test'
import { ensureHermeticFileScopeForBun } from './test-hermetic-env'
import { assertHermeticStateDir } from './test-hermetic-state-guard'

/**
 * Per-file hermetic roots under `bun test` [POD-553].
 *
 * `test-hermetic-env.ts` is a bun preload, so it evaluates once per process. Vitest
 * re-imports its setup file per test file; bun does not. These hooks run for every test in
 * every file of one invocation: on a file boundary (`Bun.main` changes) we mint a fresh
 * container + PODIUM_STATE_DIR so two files in the same `bun test` cannot see each other's
 * state. Within a file, beforeEach only re-asserts — suites may share state across their
 * own tests, and a suite that set its own PODIUM_STATE_DIR keeps it.
 */
beforeEach(() => {
  // Bun.main is the test file currently under test (verified: advances per file in one
  // multi-file invocation without --isolate). process.argv[1] does not.
  const fileKey = typeof Bun !== 'undefined' && Bun.main ? String(Bun.main) : undefined
  ensureHermeticFileScopeForBun(fileKey)
  assertHermeticStateDir()
})
afterEach(() => assertHermeticStateDir())
