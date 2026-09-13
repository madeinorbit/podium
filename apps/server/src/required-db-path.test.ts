/**
 * NAMING THE DATABASE IS REQUIRED, AND THE REQUIREMENT IS A COMPILE RULE (PDM-346).
 *
 * WHAT WENT WRONG. Starting a server means opening a database, taking a backup of
 * it and applying every outstanding migration to it. `SessionStore.open`'s first
 * parameter defaulted to `defaultDbPath()`, so a caller that said nothing selected
 * the operator's live instance — and `startServer` said nothing, because it had no
 * `dbPath` option to say anything with. Nothing had to go wrong for the live
 * database to be opened, backed up and migrated; that was the behaviour of
 * omission, and one process-global (`PODIUM_STATE_DIR`) was the only thing
 * deciding which database it was. It is how nine epic migrations were applied to
 * the running instance.
 *
 * WHY A COMPILE RULE RATHER THAN A CHECK. A runtime refusal is a check: it fires
 * when the wrong thing is already being attempted, in whichever lane happens to
 * execute that line, and a lane that never runs never fires it. A required
 * parameter is a rule: `startServer({ port: 0 })` does not build. The three doors
 * below are the complete set — `openStoreDatabase` and `migrateStoreConnection`
 * each have exactly ONE caller in the repository, `SessionStore.open`, so there is
 * no fourth way to open, back up and migrate a database. `openTestStore` is the
 * second door because it forwarded an optional path straight through, and the
 * incident walked through precisely that one.
 *
 * WHY THE PROBES ARE SELF-FALSIFYING. If any of the three got its default back,
 * the `@ts-expect-error` above it would have nothing to suppress and the compiler
 * reports TS2578 — "Unused '@ts-expect-error' directive" — on that line. The probe
 * cannot pass empty. The accepted calls below it prove the signatures can still say
 * yes, so the probes are not vacuously red either.
 *
 * WHAT A COMPILE RULE STILL CANNOT SEE, and why the runtime test below exists: a
 * `startServer` that ACCEPTS `dbPath` and quietly ignores it typechecks perfectly.
 * The last test in this file is what makes the parameter load-bearing rather than
 * decorative.
 *
 * AND WHERE THE RULE DOES NOT REACH. `apps/server/tsconfig.json` includes `src`
 * and `scripts/tsconfig.json` includes `scripts`, so those call sites are bound.
 * `tests/e2e/` is in no project's tsconfig and is typechecked by nothing, so its
 * `startServer` callers name a path because they were edited to, not because a
 * compiler requires it of them.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { noJanitorWorkerForTests } from './janitor-host'
import { startServer } from './server'
import { defaultDbPath, SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'

/**
 * THE COMPILE-TIME HALF. Never called — these lines are read by the compiler, not
 * run. `bun run --filter @podium/server typecheck` is the gate that holds them.
 */
async function _omittingTheDatabaseDoesNotCompile(): Promise<void> {
  // @ts-expect-error `dbPath` is REQUIRED on startServer. Restore a default and
  // this directive goes unused (TS2578) instead of silently passing.
  await startServer({ port: 0, janitorWorkerForTests: noJanitorWorkerForTests })
  // @ts-expect-error `path` is REQUIRED on SessionStore.open — the single door
  // through which any database is opened, backed up and migrated.
  await SessionStore.open()
  // @ts-expect-error `path` is REQUIRED on openTestStore. This is the exact call
  // the incident made, with the argument that was `undefined` removed entirely.
  await openTestStore()
}
void _omittingTheDatabaseDoesNotCompile

/**
 * THE POSITIVE CONTROL. Also never called. If the three signatures had collapsed
 * to something that forbids nothing, the probes above would be vacuous; these
 * prove each door still accepts a path that is named.
 */
async function _namingTheDatabaseCompiles(): Promise<void> {
  await startServer({
    dbPath: defaultDbPath(),
    port: 0,
    janitorWorkerForTests: noJanitorWorkerForTests,
  })
  await SessionStore.open(':memory:')
  await openTestStore(':memory:')
}
void _namingTheDatabaseCompiles

describe('the database a server boot opens is the one its caller named', () => {
  const priorStateDir = process.env.PODIUM_STATE_DIR
  const dirs: string[] = []
  let handle: Awaited<ReturnType<typeof startServer>> | undefined

  const scratch = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }

  afterEach(async () => {
    await handle?.close()
    handle = undefined
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /**
   * THE OPTION IS LOAD-BEARING, not decorative. The two directories are DIFFERENT
   * on purpose: the state dir is where `defaultDbPath()` would have pointed, so a
   * `startServer` that accepted `dbPath` and went on resolving the default itself
   * would put `podium.db` in `stateDir` and this test would fail by name. Both
   * halves are asserted — the named file appears, and the defaulted one does not —
   * because either alone is satisfied by a server that opened both.
   *
   * AND THE NEGATIVE HALF IS ASSERTED ON THE INCIDENT'S OWN ARTEFACT, not just on
   * the database file. What the live instance was actually left with was a BACKUP
   * beside its database and nine applied migrations: `backupDatabase` writes
   * `<db>.backup-v<n>` (plus `-wal`/`-shm`) into `dirname(dbPath)` before a
   * migration advances the schema. The presence of one in the state dir would mean
   * a PRE-EXISTING database there had been opened and migrated — the exact thing
   * that must be impossible. The whole directory listing goes into the failure
   * message, so a future reader sees WHAT appeared rather than only that something
   * did; a deliberate break names `podium.db`, `podium.db-shm`, `podium.db-wal`.
   *
   * WHAT IS PROVEN AND WHAT IS NOT, precisely. `databaseShaped` is proven in both
   * directions: it reports empty here, and the test below asserts it is NON-empty
   * when the caller does name the state directory, so the filter can say yes as
   * well as no. `migrationBackups` is NOT proven — this test's state directory
   * starts empty, and a fresh database gets no backup, so nothing in these
   * conditions can make that filter fire. It is a guard covering the case this
   * test cannot construct (a pre-existing out-of-date database), and constructing
   * one means rewinding a NAMED migration, which is coupling that rots. Recorded
   * as a guard rather than counted as a witness.
   */
  it('opens the path it was given and never the state directory default', async () => {
    const stateDir = scratch('pdm346-state-')
    const elsewhere = scratch('pdm346-db-')
    process.env.PODIUM_STATE_DIR = stateDir
    const named = join(elsewhere, 'named.db')

    handle = await startServer({
      dbPath: named,
      port: 0,
      janitorWorkerForTests: noJanitorWorkerForTests,
    })

    // `expect.soft` on all three, DELIBERATELY: a hard `expect` on the positive
    // half would abort the test before the negative half ever ran, so the
    // state-dir assertions would be vacuous under exactly the regression they
    // exist to catch (a startServer that ignores `dbPath` fails the first line).
    // Soft assertions make each half independently observable, and a deliberate
    // break reddens every half it actually broke instead of only the first.
    expect.soft(existsSync(named)).toBe(true)
    expect.soft(existsSync(join(stateDir, 'podium.db'))).toBe(false)

    const left = readdirSync(stateDir)
    expect
      .soft({
        databaseShaped: left.filter((name) => name.startsWith('podium.db')),
        migrationBackups: left.filter((name) => name.includes('.backup-v')),
        stateDirContents: left,
      })
      .toEqual({
        databaseShaped: [],
        migrationBackups: [],
        stateDirContents: left,
      })
  })

  /**
   * And `defaultDbPath()` still means what it says, so the callers that write it
   * — every runner in the repository — are not quietly getting something else.
   *
   * THIS IS ALSO THE POSITIVE CONTROL for the `databaseShaped` filter used above.
   * A filter that matched nothing would let the previous test pass while the state
   * directory filled up, so it is asserted here against real boot output: same
   * expression, same directory listing, NON-empty result.
   */
  it('puts the database under the state directory when the caller names defaultDbPath()', async () => {
    const stateDir = scratch('pdm346-default-')
    process.env.PODIUM_STATE_DIR = stateDir

    handle = await startServer({
      dbPath: defaultDbPath(),
      port: 0,
      janitorWorkerForTests: noJanitorWorkerForTests,
    })

    expect(existsSync(join(stateDir, 'podium.db'))).toBe(true)
    expect(readdirSync(stateDir).filter((name) => name.startsWith('podium.db'))).toContain(
      'podium.db',
    )
  })
})
