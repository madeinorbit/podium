/**
 * Refuse to resolve the OPERATOR'S LIVE state tree from inside a test runtime.
 *
 * THE INCIDENT. A bare `bun -e` one-liner called `openTestStore(process.env.SEED_DB)`
 * with `SEED_DB` unset. `undefined` fell through `SessionStore.open()`'s default
 * parameter to `defaultDbPath()` -> `stateDir()` -> `instanceStateDir()`, which
 * returns `<home>/.podium` when PODIUM_STATE_DIR is unset — the operator's LIVE
 * tracker. Opening it took a pre-migration backup and applied nine unreleased
 * migrations to the database a running server was serving from.
 *
 * WHY THIS IS A PATH-CONSTRUCTOR CONCERN AND NOT A TEST-HARNESS ONE.
 * Nothing in that chain is a mistake anyone typed. Every step is a DEFAULT:
 *
 *     instanceStateDir()   packages/runtime/src/instance.ts   <home>/.podium
 *     defaultDbPath()      apps/server/src/store.ts           + 'podium.db'
 *     SessionStore.open()  apps/server/src/store.ts           path = defaultDbPath()
 *     startServer()        apps/server/src/server.ts          SessionStore.open(undefined, ...)
 *
 * So opening the live database is what a process gets by DOING NOTHING. The existing
 * defence (`test-hermetic-env.ts` pointing PODIUM_STATE_DIR at a throwaway, plus
 * `assertHermeticStateDir()` at vitest hook boundaries) is an ASSERTION ABOUT AN ENV
 * VAR, checked in the vitest process at hook boundaries. It is installed in exactly
 * two places — vitest `setupFiles` and bunfig's `[test].preload` — and therefore
 * cannot see:
 *   - a bare `bun -e` / `bun <script>` invocation, which is neither runner;
 *   - a child process handed a curated `env` literal instead of `hermeticChildEnv()`;
 *   - a vitest config whose `setupFiles` never included the hermetic pair;
 *   - the window INSIDE a test body between a `delete process.env.PODIUM_STATE_DIR`
 *     and the restoring `afterEach` (hooks unwind stack-order: the file's own
 *     afterEach runs BEFORE the setup file's guard).
 *
 * The refusal therefore moves to the one place all of those funnel through: the
 * resolver itself. Under a marked test runtime, resolving the live root stops being
 * a mistake that gets caught and becomes a thing that is not representable.
 *
 * TWO ENV VARS, AND WHY NEITHER IS "just another flag someone must remember".
 *  - PODIUM_TEST_RUNTIME=1 — "this process tree is a test run". Written ONCE by
 *    `test-hermetic-env.ts`, which every vitest lane loads as a setupFile and
 *    `bun test` loads as a bunfig preload. Children INHERIT it through the ordinary
 *    environment, which is the point: a child that inherits is exactly the case
 *    `hermeticChildEnv()` never covered, because that contract depends on each spawn
 *    site remembering to call it. STATED HONESTLY, the two are complementary rather
 *    than total: a child spawned with a CURATED env literal that is neither the
 *    inherited environment nor `hermeticChildEnv()` carries neither marker, and the
 *    guard is inert for it exactly as it is in production. That child is still covered
 *    by the census — its lane's config is in the walk — but not by this refusal.
 *  - PODIUM_LIVE_STATE_DIR — the live root as it was BEFORE any test mutated $HOME.
 *    It must be CAPTURED rather than recomputed: under Bun both `os.homedir()` and
 *    `os.userInfo().homedir` read $HOME (verified on this branch), so once a test sets
 *    `HOME=/tmp/fake` the real home is unknowable after the fact. The hermetic setup
 *    runs at the one moment it still is knowable, and publishes the answer.
 *
 * In production NEITHER var is set, every function here returns its input, and the
 * guard costs one undefined comparison. `live-state-guard.test.ts` asserts that
 * inertness as its own case — without it, "it throws" would pass equally for a guard
 * that throws unconditionally, and the shipped binary could not open its own database.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const TEST_RUNTIME_ENV = 'PODIUM_TEST_RUNTIME'
export const LIVE_STATE_DIR_ENV = 'PODIUM_LIVE_STATE_DIR'

/** Just the two markers; any `process.env`-shaped object satisfies it. */
export type LiveStateGuardEnv = Readonly<Record<string, string | undefined>>

/**
 * True when `candidate` is the live root itself or anything beneath it.
 *
 * Containment is decided by `path.relative`, NOT by a string prefix: `~/.podium-test`
 * starts with the same characters as `~/.podium` and must be ALLOWED, or the first
 * person whose scratch root is refused relaxes this to a substring test and the guard
 * stops meaning anything.
 */
export function isWithinLiveStateDir(candidate: string, liveStateDir: string): boolean {
  const rel = relative(resolve(liveStateDir), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * The live state root this process tree must never resolve, or `undefined` when the
 * environment is not a marked test runtime — i.e. production, and any hand-run tool.
 *
 * BOTH markers are required. A half-published pair disarms the guard rather than
 * guessing, because a guessed live root is a guessed refusal.
 */
export function guardedLiveStateDir(env: LiveStateGuardEnv = process.env): string | undefined {
  if (env[TEST_RUNTIME_ENV] !== '1') return undefined
  const live = env[LIVE_STATE_DIR_ENV]?.trim()
  return live ? resolve(live) : undefined
}

/**
 * Return `candidate` unchanged, or throw if a marked test runtime just resolved the
 * operator's live state tree.
 *
 * `site` names the resolver, because the useful half of the message is WHICH default
 * fired: "instanceStateDir fell back to $HOME/.podium" and "openStoreDatabase was
 * handed a live path" are different bugs with different fixes.
 */
export function refuseLiveStateDir(
  candidate: string,
  site: string,
  env: LiveStateGuardEnv = process.env,
): string {
  const live = guardedLiveStateDir(env)
  if (live === undefined || !isWithinLiveStateDir(candidate, live)) return candidate
  throw new Error(
    `[live-state-guard] ${site} resolved the operator's live state tree ` +
      `(${resolve(candidate)}) inside a test run. Opening it takes a backup and applies ` +
      `every pending migration to a running instance's database. Set PODIUM_STATE_DIR ` +
      `(or pass an explicit path) for this process; if this is a child process, pass ` +
      `hermeticChildEnv() as its \`env\` rather than an env literal.`,
  )
}
