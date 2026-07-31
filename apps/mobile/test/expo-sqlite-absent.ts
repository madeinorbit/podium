/**
 * `expo-sqlite`, ABSENT — the unit lane's stand-in for the native module (POD-1220).
 *
 * WHY A STUB AND NOT THE REAL PACKAGE. `expo-sqlite` pulls `expo-modules-core`, which
 * reads `globalThis.expo.EventEmitter` at module scope: the native runtime, which no
 * Node test has. Importing the composition root would fail before a single case ran.
 *
 * WHY THIS DOES NOT WEAKEN ANYTHING. `openMobileReplica` never names this package —
 * it takes `openDatabase` and `deleteDatabase` as arguments, and the tests hand it a
 * REAL SQLite (`bun:sqlite` / `node:sqlite`) over a REAL file. The only code that
 * reaches for the native module is `LiveProvider`'s effect, which is the device path.
 *
 * SO EVERY MEMBER THROWS. A stub that returned a plausible object would let a future
 * edit route a tested path through the native module and pass, testing the stub. The
 * throw makes that a loud failure naming this file.
 */

const absent = (member: string) => (): never => {
  throw new Error(
    `expo-sqlite.${member} was called in the unit lane. Nothing under test may reach the ` +
      'native module — the database is injected. See apps/mobile/test/expo-sqlite-absent.ts.',
  )
}

export const openDatabaseSync = absent('openDatabaseSync')
export const deleteDatabaseSync = absent('deleteDatabaseSync')
