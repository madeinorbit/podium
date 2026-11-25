import { memberFacts } from '../../store/fixtures/test-support'
/**
 * The instance settings edit costs a constant number of statements (POD-6677,
 * rule 8 of docs/agents/server-data.md).
 *
 * An admin's edit runs on `sync.submit` against a store that holds `size`
 * members and `size` of their personal preference leaves: the write reads the
 * one settings row and the caller's own preferences, writes the one row, and
 * its change entry is the one record, never a scan of anybody else's rows.
 */

import { asUserId, firstAdminMemberId, INSTANCE_PREFERENCES_ROW_ID } from '@podium/model'
import { superagentBackendIsUnset } from '@podium/runtime'
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
  // The host daemon's inventory seeds the admin's superagent default in the
  // background; it lands before the run, not inside it, at either size.
  await expect
    .poll(async () =>
      superagentBackendIsUnset(
        (await o.store.settings.getSettingsFor(firstAdminMemberId())).roles.superagent,
      ),
    )
    .toBe(false)
  for (let i = 0; i < size; i++) {
    const other = asUserId(`user:member-${i}`)
    await memberFacts(o.store).create({
      id: other,
      displayName: `member ${i}`,
      email: null,
      role: 'member',
      createdAt: AT,
      disabledAt: null,
    })
    await o.store.settings.applyPreferencePatch(other, { 'sidebar.repoSort': 'custom' }, AT)
  }
  // The setup's own deliveries run before the count, not inside it (POD-7068).
  // Each member's join is a delivery that, since POD-7552 (6ac0969a11), records
  // the access moves it names: left queued, about a third of them ran inside the
  // edit's window at 200 members and read as growth of the edit (27 -> 352).
  await o.reg.changeLedger.authority.settled()
  return o
}

// Each edit names a new value, so every run writes and publishes.
const instanceEdit = {
  name: 'records.instancePreferences.edit',
  setup: fixture,
  target: (o) => o.store,
  // The edit's own delivery runs inside the count, whole (POD-7068): it trails
  // the commit, and a window that ended when the submit returned held as many of
  // its reads as had started by then.
  run: async (o) => {
    const reply = appliedReply(
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
    )
    await o.reg.changeLedger.authority.settled()
    return reply
  },
  // The edit must PUBLISH its record, not only write the blob: a source that stops
  // capturing the settings row costs about as many statements as the move that
  // broke it, so the count alone did not show the lost change (POD-7061).
  check: async (reply, o) => {
    expect((reply as ReturnType<typeof appliedReply>).replayed).toBe(false)
    const head = await o.store.sync.maxChangeSeq()
    expect(await o.store.sync.changesSince(head - 1)).toContainEqual(
      expect.objectContaining({ entity: 'instancePreferences', op: 'upsert' }),
    )
  },
} satisfies StatementPin<Oracle>

describe('statement counts of the instance settings edit', () => {
  it('does not grow with the members or the preferences the store holds', async () => {
    // POD-6769: the record is built before and after the blob write (+1). The
    // base ran 16 against its pin of 15 at f4053a3909.
    // POD-6920: derived change capture adds the commit's capture mark: 17 -> 18.
    // RE-PINNED 18 -> 21 FOR POD-7061: the settings blob moved to workspace_meta
    // (POD-7013) while its record source still named meta, so the edit published
    // no change and still ran 18. With the source on workspace_meta it publishes
    // again: the change row, the feed head and the record's read of the new blob.
    // POD-7604: re-measured with the setup's deliveries drained and the edit's own
    // delivery counted whole: 18 at 5 and at 200 members. Undrained, the members'
    // join deliveries (each recording access moves since POD-7552, 6ac0969a11) ran
    // inside the window and read as growth, 27 at 5 and 352 at 200. The 18: the
    // ledger's lookup and receipt, the caller's account and preferences, the
    // settings and secret reads, the blob write and its audit, the capture and
    // drain, the change row and the feed head; nothing per member.
    await expectConstantStatements(instanceEdit, 18)
  })

  it('is armed: a read per member on the edit path fails it', async () => {
    await expectArmed(instanceEdit, 18, (o, size) => {
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
