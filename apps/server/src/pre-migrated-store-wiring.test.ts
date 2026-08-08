/**
 * The wiring guard for POD-523's pre-migrated store fixture, from the other side.
 *
 * `migrations/pre-migrated-fixture.test.ts` proves the fixture is ABSENT where the
 * real chain is required. This file is an ordinary server test file, so it proves
 * the fixture is PRESENT where it is supposed to be — the setupFile, the globalSetup
 * and the image all resolved for real, in the lane that actually runs.
 *
 * Without it, a broken wiring (a renamed setup file, a lane that lost `globalSetup`,
 * an unwritable cache) would show up only as a suite that quietly got slow again.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { appliedDrizzleNames } from './migrations'
import { DRIZZLE_MIGRATIONS } from './migrations/drizzle-manifest.generated'
import { SessionStore } from './store'
import { storeDatabaseOpenerInstalled } from './store-database'
import { FIXTURE_DISABLED_ENV, schemaImagePath } from './test-support/pre-migrated-store'

/**
 * Every way vitest lets a case stop running without being deleted.
 *
 * Anchored patterns, not substrings: they must match a real call site at the start of
 * a line, so this list does not trip over its own text in the file it audits. Note
 * `.skipIf(` is deliberately NOT matched — that is the legitimate A/B arm, where
 * there is no fixture to compare against.
 *
 * Deliberately duplicated in the file this one audits rather than shared: a common
 * constant would be one edit that disarms both halves, which is the thing the mutual
 * audit exists to prevent.
 */
const DISABLERS = [
  /^\s*(?:it|test|describe)\.(?:skip|only|todo|fails)\s*\(/m,
  /^\s*x(?:it|describe)\s*\(/m,
]

/** The A/B arm that runs everything on the real chain expects the opposite. */
const disabled = process.env[FIXTURE_DISABLED_ENV] !== undefined

describe('pre-migrated store fixture wiring [POD-523]', () => {
  it('is installed for an ordinary apps/server test file', () => {
    expect(schemaImagePath() !== undefined).toBe(!disabled)
    expect(storeDatabaseOpenerInstalled()).toBe(!disabled)
  })

  it('hands an ordinary store a database already at the head of the chain', () => {
    const store = new SessionStore(':memory:')
    // @ts-expect-error private db — this test's subject is how the db was built
    const ledger = appliedDrizzleNames(store.db)
    expect(ledger.size).toBe(DRIZZLE_MIGRATIONS.length)
    store.close()
  })
})

describe("the fixture's own guards stay armed [POD-523]", () => {
  /**
   * A MUTUAL source audit with `migrations/pre-migrated-fixture.test.ts`: that file
   * checks this one, this one checks that file. Neither can be quarantined without
   * editing the other, and they share neither a directory nor a name — so a sweep
   * that retires one by name-match leaves the other shouting.
   *
   * The case being protected is not an ordinary test. `reaches identical schema
   * objects and rows` is the single assertion standing between a wrong image and a
   * green gate: skipped, every store-backed suite in the package goes on passing
   * against a schema nobody checked. Making the migrations opt-out structural and
   * then leaving its proof `.skip`-able would have been decoration.
   */
  it('keeps the clone-equals-chain proof active and unskipped', () => {
    const source = readFileSync(
      new URL('./migrations/pre-migrated-fixture.test.ts', import.meta.url),
      'utf8',
    )
    for (const required of [
      "it('reaches identical schema objects and rows'",
      "it('gives every store an independent database'",
      "it('never lets a write reach the shared image'",
      "it('keys the cache on every migration name and sql'",
      "it('still applies every migration in the manifest on a fresh database'",
    ]) {
      expect(source, `the fixture proof no longer contains ${required}`).toContain(required)
    }
    for (const disabler of DISABLERS) {
      expect(disabler.test(source), `the fixture proof has been disabled: ${disabler}`).toBe(false)
    }
  })
})
