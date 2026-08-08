/**
 * Pre-migrated store fixture [POD-523] — ordinary server tests CLONE a
 * current-schema database instead of replaying the 54-migration chain.
 *
 * THE COST THIS REMOVES. `new SessionStore(':memory:')` measured 469 ms warm, of
 * which 408 ms is the migration chain; the POD-515 cold profile counted 2,341 full
 * chain applications in one `@podium/server` run. Cloning the finished page image
 * costs ~4 ms, so the same construction lands near 65 ms, and the chain itself is
 * run once per checkout rather than once per store.
 *
 * WHAT THE CLONE IS. The byte-for-byte page image (`sqlite3_serialize`) of a
 * database built BY RUNNING THE REAL MIGRATIONS — see `pre-migrated-store.image.ts`.
 * Not a schema dump, not a checked-in `.db`: there is no transcription of the schema
 * anywhere, so there is nothing that can drift from the migrations.
 *
 * WHY IT CANNOT GO STALE — the property the sync rewrite depends on, because a stale
 * schema would hide a real defect rather than fail. The image's filename IS a digest
 * of every migration's name and sql (`schemaFingerprint`), recomputed at the start of
 * every run. Schema DDL lives only in `src/migrations/`, so a schema change is a
 * manifest change, is a different digest, is a different file, is a rebuild. Nothing
 * has to remember to invalidate anything; a stale image is unreachable, not trusted.
 * A freshly built image is additionally checked against the manifest's ledger, which
 * catches what a hash cannot: a truncated write or a foreign file.
 *
 * WHY STATE CANNOT CROSS TESTS. `sqlite3_deserialize` COPIES the image into a new
 * in-memory database, and this module hands it a private copy on top of that, so the
 * isolation does not rest on bun's ownership semantics. Writes by one store reach
 * neither the image nor any other store. Proven in `pre-migrated-fixture.test.ts`.
 *
 * WHAT KEEPS THE FULL CHAIN. `usesRealMigrationChain()`: everything under
 * `src/migrations/`, structurally, plus a named allowlist. Those suites build their
 * stores through the untouched constructor, so upgrade ordering, the out-of-order
 * guard, the pre-migration backup, the downgrade refusal and the boot log are all
 * still exercised against 54 real steps.
 *
 * THIS MODULE IS ON THE PER-FORK PATH — a vitest setupFile imports it for every
 * apps/server test file, including the ~200 that never construct a store. It
 * therefore imports no migration code at all; the chain lives in the two sibling
 * modules, which run once in vitest's main process. See
 * `pre-migrated-store.build.ts` for the measurement that forced that split.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { openDatabase, openDatabaseFromImage, type SqlDatabase } from '@podium/runtime/sqlite'
import { installStoreDatabaseOpener, resetStoreDatabaseOpener } from '../store-database'

/**
 * Where `globalSetup` left the verified image for THIS run. Passed by environment
 * rather than vitest's `provide`/`inject` because the forks must read it from a
 * plain synchronous function — `SessionStore`'s constructor cannot await anything.
 */
export const SCHEMA_IMAGE_ENV = 'PODIUM_TEST_SCHEMA_IMAGE'

/**
 * Set this to put every store back on the real 54-step chain. It is how the two
 * arms of the acceptance evidence are produced ("same results, with and without"),
 * and the first thing to reach for when a store-backed test looks wrong.
 */
export const FIXTURE_DISABLED_ENV = 'PODIUM_TEST_NO_SCHEMA_FIXTURE'

/**
 * Server test files that must keep constructing their stores through the real
 * 54-step chain even though they do not live under `src/migrations/`.
 *
 * Paths are relative to `apps/server/src/`. Add a file here when it asserts on
 * migration ORDER, on the boot `applied migrations:` log, on the pre-migration
 * backup, or on the downgrade refusal — anything whose subject is the act of
 * migrating rather than the schema it arrives at. A test that merely reads schema
 * SHAPE belongs on the clone instead, where it doubles as a canary that the clone
 * and the chain agree: `characterization.test.ts` dumps all of `sqlite_master` and
 * `store.issues.test.ts` walks `PRAGMA table_info`, and both stayed on the fixture
 * for exactly that reason.
 */
const REAL_MIGRATION_CHAIN_TESTS: ReadonlySet<string> = new Set<string>([])

/** `src/migrations/**` is opted out structurally — it cannot be forgotten. */
const MIGRATIONS_DIR = 'migrations/'

const SERVER_SRC = '/apps/server/src/'

/**
 * True when the test file at `testPath` must build its stores through the real
 * migration chain. Non-server files answer `true` too: the fixture is only ever
 * installed for `apps/server`, and saying so keeps the predicate total.
 */
export function usesRealMigrationChain(testPath: string): boolean {
  const normalized = testPath.replaceAll('\\', '/')
  const at = normalized.lastIndexOf(SERVER_SRC)
  if (at === -1) return true
  const relative = normalized.slice(at + SERVER_SRC.length)
  return relative.startsWith(MIGRATIONS_DIR) || REAL_MIGRATION_CHAIN_TESTS.has(relative)
}

/**
 * Install the fixture for the test file at `testPath` unless that file is one of the
 * suites that must keep the real chain. Returns whether it was installed — false
 * also when this run has no image, which simply leaves every store on the chain.
 *
 * The image is read LAZILY, on the first store construction, so a server test file
 * that never touches `SessionStore` pays nothing for this.
 */
export function installPreMigratedStoreFixtureFor(testPath: string): boolean {
  if (usesRealMigrationChain(testPath)) return false
  if (schemaImagePath() === undefined) return false
  installPreMigratedStoreFixture()
  return true
}

/** Install the fixture unconditionally (for the fixture's own tests). */
export function installPreMigratedStoreFixture(): void {
  installStoreDatabaseOpener(openPreMigrated)
}

/**
 * Restore the real chain for the rest of this test file — the escape hatch for a
 * suite outside `src/migrations/` that needs a genuine 54-step boot.
 */
export function useRealMigrationChain(): void {
  resetStoreDatabaseOpener()
}

/** The image path for this run, or undefined when no fixture was prepared. */
export function schemaImagePath(): string | undefined {
  const configured = process.env[SCHEMA_IMAGE_ENV]
  return configured && existsSync(configured) ? configured : undefined
}

let memoized: Uint8Array | undefined

/** The page image of a database at the head of the migration chain. */
export function currentSchemaImage(): Uint8Array {
  if (memoized === undefined) {
    const path = schemaImagePath()
    if (path === undefined) {
      throw new Error(
        `pre-migrated fixture: ${SCHEMA_IMAGE_ENV} names no readable image. The vitest ` +
          `globalSetup that builds it did not run for this lane.`,
      )
    }
    memoized = readFileSync(path)
  }
  return memoized
}

/** A fresh database cloned from the image. Requires an image to exist. */
export function openSchemaClone(): SqlDatabase {
  return openDatabaseFromImage(copyOf(currentSchemaImage()))
}

function openPreMigrated(path: string): SqlDatabase {
  if (path === ':memory:') return openSchemaClone()
  // A file that already exists is a database the test built on purpose — an older
  // schema to upgrade, or a store being reopened. Seeding only the empty case keeps
  // "an existing database advances by its pending migrations" exactly as it was.
  // No copy needed: `writeFileSync` does not retain the buffer.
  if (!existsSync(path) || statSync(path).size === 0) writeFileSync(path, currentSchemaImage())
  return openDatabase(path)
}

/**
 * A private copy, so no clone can reach the image every other clone came from.
 *
 * `set` and not `Uint8Array.from(image)`: `from` walks 816 K elements one at a time
 * and cost more than the whole clone it was guarding. This is a memcpy.
 */
function copyOf(image: Uint8Array): Uint8Array {
  const copy = new Uint8Array(image.byteLength)
  copy.set(image)
  return copy
}
