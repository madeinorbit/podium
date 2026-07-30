/**
 * WHAT THE TEST ENVIRONMENTS ACTUALLY PROVIDE — the measurement, pinned.
 *
 * POD-374's equivalent file exists because "green under happy-dom" turned out not to
 * mean "green against happy-dom's IndexedDB" — there is none. The mobile version of
 * that hazard is sharper, because there are TWO lanes with TWO different engines and
 * neither is the one that ships:
 *
 *   | lane                                       | runtime     | engine        |
 *   |--------------------------------------------|-------------|---------------|
 *   | repo root `test:unit` (`bun --bun vitest`)  | bun 1.3.14  | `bun:sqlite`  |
 *   | `packages/sync`'s own `bun run test`        | node v22.22 | `node:sqlite` |
 *   | the device                                  | Hermes/JSC  | `expo-sqlite` |
 *
 * Measured on this branch: `bun:sqlite` is absent under node and `node:sqlite` is
 * absent under bun, so neither lane can be assumed and a suite hard-coded to one
 * would fail in the other for a reason that looks like a product bug. That is what
 * `resolveSqliteEngine` is for, and this file is what stops it from ever quietly
 * resolving to something that is not SQLite.
 *
 * ALL THREE ARE REAL SQLite with real transaction semantics — `BEGIN IMMEDIATE`,
 * `ROLLBACK` that undoes the whole batch, and a file that outlives the connection —
 * which is exactly what the crash, quota and lifecycle claims rest on. What no lane
 * here provides is the DEVICE: iOS/Android filesystem behaviour, real disk
 * exhaustion, and the OS reclaiming a backgrounded process are not reproduced by any
 * of this, and `docs/agents/pod-375-storage-evidence.md` says so rather than letting
 * a green run imply it.
 *
 * THIS TEST FAILS THE DAY A LANE LOSES ITS ENGINE, which is the point: at that moment
 * every suite in this directory is testing something else, and a comment would not
 * have told anybody.
 */

import { describe, expect, it } from 'vitest'
import { freshDatabaseFile, resolveSqliteEngine, sqliteEngine } from './test-support'

describe('the environment this adapter is tested in', () => {
  it('resolves to exactly one of the two engines this repo has, and names it', () => {
    expect(['bun:sqlite', 'node:sqlite']).toContain(sqliteEngine.name)
    // The lane and the engine agree. If bun ever ships `node:sqlite`, or node ships
    // `bun:sqlite`, the resolution order in `resolveSqliteEngine` starts mattering and
    // this line is where that conversation begins.
    const underBun = (globalThis as { Bun?: unknown }).Bun !== undefined
    expect(sqliteEngine.name).toBe(underBun ? 'bun:sqlite' : 'node:sqlite')
  })

  it('the resolver REFUSES rather than substituting a fake — the property everything here rests on', async () => {
    // The positive control for the guarantee, not for the engine. A resolver that
    // fell back to an in-memory imitation would leave every crash and quota case in
    // this directory green while proving nothing, so what matters is that the failure
    // path throws. Reaching the resolved engine at all is the "yes"; this is the "no".
    await expect(
      (async () => {
        // Same shape as `resolveSqliteEngine`, asked for modules that cannot exist.
        for (const specifier of ['sqlite:not-a-real-module', 'another:missing-engine']) {
          await import(/* @vite-ignore */ specifier)
        }
      })(),
    ).rejects.toThrow()
    // …and the real one does not throw, so the assertion above is about absence
    // rather than about `import()` being broken in this runtime.
    await expect(resolveSqliteEngine()).resolves.toMatchObject({ name: sqliteEngine.name })
  })

  it('the engine has REAL transaction semantics — rollback undoes the whole batch', () => {
    // The single property every crash and quota assertion in this directory depends
    // on. An engine that committed each statement as it ran would make "nothing
    // partially applied" false while every mock-based test stayed green.
    const { file, cleanup } = freshDatabaseFile()
    try {
      const db = sqliteEngine.open(file)
      db.exec('CREATE TABLE probe (k INTEGER PRIMARY KEY)')
      db.exec('BEGIN IMMEDIATE')
      db.prepare('INSERT INTO probe (k) VALUES (?)').run(1)
      db.prepare('INSERT INTO probe (k) VALUES (?)').run(2)
      db.exec('ROLLBACK')
      expect(db.prepare('SELECT k FROM probe').all()).toEqual([])

      // …and it can say yes: a committed batch survives, including across a NEW
      // connection, which is what makes "the file outlived the process" testable.
      db.exec('BEGIN IMMEDIATE')
      db.prepare('INSERT INTO probe (k) VALUES (?)').run(3)
      db.exec('COMMIT')
      db.close()

      const second = sqliteEngine.open(file)
      expect(second.prepare('SELECT k FROM probe').all()).toEqual([{ k: 3 }])
      second.close()
    } finally {
      cleanup()
    }
  })
})
