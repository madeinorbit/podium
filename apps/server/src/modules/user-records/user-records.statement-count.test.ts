/**
 * The per-user record writes cost a constant number of statements (POD-6673,
 * rule 8 of docs/agents/server-data.md).
 *
 * A pin, a tab order, a preference edit and a read position each run on `sync.submit` against a
 * store that holds `size` other people's pins, orders and preference leaves, and
 * `size` of the caller's own: the write reads and writes its one row, and its
 * change entry is the record it changed, never a scan of the table.
 */

import {
  asUserId,
  firstAdminMemberId,
  pinRowId,
  readPositionRowId,
  tabOrderRowId,
  userPreferencesRowId,
} from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
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
const AT = '2026-11-08T00:00:00.000Z'
let seq = 0

interface Fixture {
  readonly o: Oracle
  readonly session: string
}

async function fixture(size: number): Promise<Fixture> {
  const o = await makeOracle()
  const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
  for (let i = 0; i < size; i++) {
    const other = asUserId(`user:other-${i}`)
    await o.store.sessions.addPin(other, 'repo', `/repo/${i}`, AT)
    await o.store.sessions.addPin(ME, 'worktree', `/mine/${i}`, AT)
    await o.store.sessions.setTabOrder(other, `/w/${i}`, ['s1'])
    await o.store.sessions.setTabOrder(ME, `/mine/${i}`, ['s1'])
    await o.store.settings.applyPreferencePatch(other, { 'sidebar.repoSort': 'custom' }, AT)
    await o.store.readPositions.advance(
      fixtureWriteScope(),
      other,
      'issueEvents',
      { lastEventId: i + 1, seenAt: null },
      AT,
    )
  }
  return { o, session: sessionId }
}

const write = (name: string, envelopeOf: (f: Fixture, n: number) => ReturnType<typeof envelope>) =>
  ({
    name,
    setup: fixture,
    target: (f) => f.o.store,
    run: async (f) => appliedReply(await submit(f.o, envelopeOf(f, ++seq))),
    check: (reply) => expect((reply as ReturnType<typeof appliedReply>).replayed).toBe(false),
  }) satisfies StatementPin<Fixture>

const pinCreate = write('records.pin.create', (_f, n) =>
  envelope(
    'records.pin.create',
    {
      id: pinRowId(ME, 'repo', `/new/${n}`),
      fields: { userId: ME, kind: 'repo', entityId: `/new/${n}` },
    },
    `pin-${n}`,
  ),
)

const tabOrderEdit = write('records.tabOrder.edit', (f, n) =>
  envelope(
    'records.tabOrder.edit',
    { id: tabOrderRowId(ME, `/order/${n}`), patch: { sessionIds: [f.session] } },
    `tab-${n}`,
  ),
)

const preferencesEdit = write('records.userPreferences.edit', (_f, n) =>
  envelope(
    'records.userPreferences.edit',
    { id: userPreferencesRowId(ME), patch: { 'roles.coding.model': `model-${n}` } },
    `pref-${n}`,
  ),
)

// Each proposal is ahead of the last, so every run moves the cursor and writes.
const readPositionEdit = write('records.userReadPosition.edit', (_f, n) =>
  envelope(
    'records.userReadPosition.edit',
    { id: readPositionRowId(ME, 'issueEvents'), patch: { lastEventId: n, seenAt: AT } },
    `read-${n}`,
  ),
)

describe('statement counts of the per-user record writes', () => {
  it('a pin does not grow with the pins the table holds', async () => {
    await expectConstantStatements(pinCreate, 9)
  })

  it('a tab order does not grow with the orders the table holds', async () => {
    await expectConstantStatements(tabOrderEdit, 8)
  })

  it('a preference edit does not grow with the preferences the table holds', async () => {
    await expectConstantStatements(preferencesEdit, 14)
  })

  it('a read position edit does not grow with the positions the table holds', async () => {
    await expectConstantStatements(readPositionEdit, 9)
  })

  it('is armed: a read per stored pin on the pin path fails it', async () => {
    await expectArmed(pinCreate, 9, (f, size) => {
      const repo = f.o.store.sessions
      const original = repo.pinnedAt.bind(repo)
      repo.pinnedAt = async (user, kind, id) => {
        for (let i = 0; i < size; i++) await original(user, kind, `/absent/${i}`)
        return await original(user, kind, id)
      }
      return () => {
        repo.pinnedAt = original
      }
    })
  })
})
