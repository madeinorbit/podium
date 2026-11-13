/**
 * The superagent thread record's reads and writes cost a constant number of
 * statements (POD-6675, rule 8 of docs/agents/server-data.md).
 *
 * Against a store that holds `size` other people's threads and `size` of the
 * caller's own:
 *  - an owner's edit (`records.superagentThread.edit`) reads and writes its one
 *    row, and its change entry is the record it changed;
 *  - a turn's status write (`setTurnRunning`) is one row and its capture;
 *  - the boot reconcile reads the table once, whatever its size, and appends
 *    only what changed.
 */

import {
  asSessionId,
  asThreadId,
  asUserId,
  firstAdminMemberId,
  superagentThreadRowId,
} from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import {
  expectArmed,
  expectConstantStatements,
  type StatementPin,
} from '../../test-support/statement-count'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { appliedReply, envelope, submit } from '../sync-write/outbox-test-support'

afterEach(() => disposeOracles())

const ME = firstAdminMemberId()
let seq = 0

async function fixture(size: number): Promise<Oracle> {
  const o = await makeOracle()
  // A first command settles the boot's own background writes (the superagent
  // default the attached daemon's inventory seeds), so none lands in the count.
  await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
  for (let i = 0; i < size; i++) {
    for (const owner of [ME, asUserId(`user:other-${i}`)]) {
      await o.store.superagent.upsertSuperagentThread({
        id: `btw_${owner}-${i}`,
        ownerUserId: owner,
        kind: 'btw',
        originSessionId: asSessionId(`sess-${i}`),
        title: `btw ${i}`,
      })
    }
  }
  return o
}

const edit = {
  name: 'records.superagentThread.edit',
  setup: fixture,
  target: (o) => o.store,
  run: async (o) =>
    appliedReply(
      await submit(
        o,
        envelope(
          'records.superagentThread.edit',
          { id: superagentThreadRowId(ME, 'global'), patch: { title: `title ${++seq}` } },
          `thread-edit-${seq}`,
        ),
      ),
    ),
  check: (reply) => expect((reply as ReturnType<typeof appliedReply>).replayed).toBe(false),
} satisfies StatementPin<Oracle>

const turnStatus = {
  name: 'superagent turn status',
  // Every run moves the flag: the fixture leaves a turn running, the run ends it.
  setup: async (size) => {
    const o = await fixture(size)
    await o.store.superagent.setTurnRunning(asThreadId('global'), true)
    return o
  },
  target: (o) => o.store,
  run: async (o) => {
    await o.store.superagent.setTurnRunning(asThreadId('global'), false)
  },
  check: () => undefined,
} satisfies StatementPin<Oracle>

const recover = {
  name: 'interrupted thread preparation recovery',
  setup: async (size: number) => {
    const o = await fixture(size)
    await o.store.superagent.setTurnRunning(asThreadId('global'), true)
    return o
  },
  target: (o: Oracle) => o.store,
  run: async (o: Oracle) => {
    await o.store.superagent.syncTurnRunningWithPendingTurns()
    return (await o.store.superagent.getSuperagentThread('global'))?.turnRunning
  },
  check: (running: unknown) => expect(running).toBe(false),
} satisfies StatementPin<Oracle>

describe('statement counts of the superagent thread record', () => {
  it('an owner’s edit does not grow with the threads the table holds', async () => {
    // POD-6920: derived change capture (no build before the write; one drain after it): records.superagentThread.edit 10 -> 12.
    await expectConstantStatements(edit, 12)
  })

  it('a turn’s status write does not grow with the threads the table holds', async () => {
    // POD-6920: derived change capture (no build before the write; one drain after it): superagent turn status 4 -> 5.
    await expectConstantStatements(turnStatus, 5)
  })

  it('interrupted preparation recovery ignores historical threads', async () => {
    // POD-6920: derived change capture (no build before the write; one drain after it): interrupted thread preparation recovery 5 -> 6.
    await expectConstantStatements(recover, 6)
  })

  it('is armed: a read per stored thread on the edit path fails it', async () => {
    await expectArmed(edit, 12, (o, size) => {
      const repo = o.store.superagent
      const original = repo.getSuperagentThread.bind(repo)
      repo.getSuperagentThread = async (id, owner) => {
        for (let i = 0; i < size; i++) await original(`btw_absent-${i}`)
        return await original(id, owner)
      }
      return () => {
        repo.getSuperagentThread = original
      }
    })
  })
})
