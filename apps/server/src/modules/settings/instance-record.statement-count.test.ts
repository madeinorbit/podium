/**
 * The instance settings edit costs a constant number of statements (POD-6677,
 * rule 8 of docs/agents/server-data.md).
 *
 * An admin's edit runs on `sync.submit` against a store that holds `size`
 * members and `size` of their personal preference leaves: the write reads the
 * one settings row and the caller's own preferences, writes the one row, and
 * its change entry is the one record, never a scan of anybody else's rows.
 */

import { asUserId, INSTANCE_PREFERENCES_ROW_ID } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import {
  expectArmed,
  expectConstantStatements,
  type StatementPin,
} from '../../test-support/statement-count'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { appliedReply, envelope, submit } from '../sync-write/outbox-test-support'

afterEach(() => disposeOracles())

const AT = '2026-11-09T00:00:00.000Z'
let seq = 0

async function fixture(size: number): Promise<Oracle> {
  const o = await makeOracle()
  for (let i = 0; i < size; i++) {
    const other = asUserId(`user:member-${i}`)
    await o.store.users.createUnclaimed({
      id: other,
      displayName: `member ${i}`,
      email: null,
      role: 'member',
      createdAt: AT,
      disabledAt: null,
    })
    await o.store.settings.applyPreferencePatch(other, { 'sidebar.repoSort': 'custom' }, AT)
  }
  return o
}

// Each edit names a new value, so every run writes and publishes.
const instanceEdit = {
  name: 'records.instancePreferences.edit',
  setup: fixture,
  target: (o) => o.store,
  run: async (o) =>
    appliedReply(
      await submit(
        o,
        envelope(
          'records.instancePreferences.edit',
          {
            id: INSTANCE_PREFERENCES_ROW_ID,
            patch: { 'worktreeGc.afterDays': 20 + (++seq % 300) },
          },
          `instance-${seq}`,
        ),
      ),
    ),
  check: (reply) => expect((reply as ReturnType<typeof appliedReply>).replayed).toBe(false),
} satisfies StatementPin<Oracle>

describe('statement counts of the instance settings edit', () => {
  it('does not grow with the members or the preferences the store holds', async () => {
    await expectConstantStatements(instanceEdit, 15)
  })

  it('is armed: a read per member on the edit path fails it', async () => {
    await expectArmed(instanceEdit, 15, (o, size) => {
      const users = o.store.users
      const original = users.roleOf.bind(users)
      users.roleOf = async (user) => {
        for (let i = 0; i < size; i++) await original(asUserId(`user:absent-${i}`))
        return await original(user)
      }
      return () => {
        users.roleOf = original
      }
    })
  })
})
