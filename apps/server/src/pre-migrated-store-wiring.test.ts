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

import { describe, expect, it } from 'vitest'
import { appliedDrizzleNames } from './migrations'
import { DRIZZLE_MIGRATIONS } from './migrations/drizzle-manifest.generated'
import { SessionStore } from './store'
import { storeDatabaseOpenerInstalled } from './store-database'
import { FIXTURE_DISABLED_ENV, schemaImagePath } from './test-support/pre-migrated-store'

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
