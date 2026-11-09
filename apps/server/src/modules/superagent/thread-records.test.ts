/**
 * SUPERAGENT THREADS AS SYNCED PER-USER RECORDS (POD-6675, design POD-5620
 * §1.7).
 *
 * Through the real composed server: the global thread the server makes, the
 * feed capture on every thread write, the owner's generic edits on
 * `sync.submit`, and the Authority's feed with the real visibility policy (the
 * owner's devices receive a thread, nobody else does). Then the boot truth:
 * `turnRunning` from the pending turns, so a restart never leaves it stuck.
 */

import {
  asSessionId,
  asThreadId,
  asUserId,
  firstAdminMemberId,
  type SuperagentThreadWire,
  superagentThreadRowId,
} from '@podium/model'
import { asCapabilityRef, asDeviceId, type Principal } from '@podium/protocol'
import { Authority, GrantEdgeVisibilityPolicy, NoDelegationsGranted } from '@podium/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFeedVisibility } from '../../feed-visibility'
import type { PendingSuperagentTurnRow, SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { envelope, expectAppliedOnPath, submit } from '../sync-write/outbox-test-support'
import { reconcileSuperagentThreads } from './thread-records'

afterEach(() => disposeOracles())

const ME = firstAdminMemberId()
const SOMEONE_ELSE = asUserId('mem_0000000000000000000000000000')
const GLOBAL = superagentThreadRowId(ME, 'global')

const principal = (user: string): Principal => ({
  kind: 'user',
  user: asUserId(user),
  device: asDeviceId(`device:${user}`),
  capability: asCapabilityRef(`cap:${user}`),
})

const refusalOf = (reply: Awaited<ReturnType<typeof submit>>) =>
  reply.outcome === 'rejected' ? reply.refusal : undefined

/** The superagent thread records a member's device holds after a bootstrap. */
async function threadsOf(o: Oracle, user: string): Promise<Map<string, SuperagentThreadWire>> {
  const { changes } = await o.reg.changeLedger.authority.bootstrap(principal(user))
  return new Map(
    changes
      .filter((c) => c.entity === 'superagentThread' && c.op === 'upsert')
      .map((c) => [c.entityId, (c as { value: SuperagentThreadWire }).value]),
  )
}

async function btwThread(o: Oracle, owner = ME): Promise<string> {
  const id = `btw_sess-${owner}`
  await o.store.superagent.upsertSuperagentThread({
    id,
    ownerUserId: owner,
    kind: 'btw',
    originSessionId: asSessionId('sess-origin'),
    title: 'btw · origin',
  })
  return id
}

describe('superagent threads reach their owner only', () => {
  it('the server makes my global thread: it is on my bootstrap, never on another member’s', async () => {
    const o = await makeOracle()
    const mine = await threadsOf(o, ME)
    expect(mine.get(GLOBAL)).toMatchObject({
      threadId: 'global',
      ownerUserId: ME,
      kind: 'global',
      archived: false,
      turnRunning: false,
      lastTurnFailure: null,
      resumable: false,
    })
    // Positive control above; the other member holds none of mine.
    expect([...(await threadsOf(o, SOMEONE_ELSE)).keys()]).toEqual([])
  })

  it('a thread made on one device reaches my other devices by delta, and nobody else', async () => {
    const o = await makeOracle()
    const authority = o.reg.changeLedger.authority
    const before = await authority.cursor()
    const threadId = await btwThread(o)
    const id = superagentThreadRowId(ME, threadId)

    const mine = await authority.changesSince(before, principal(ME))
    const theirs = await authority.changesSince(before, principal(SOMEONE_ELSE))
    const ids = (delta: typeof mine) =>
      delta?.kind === 'batch'
        ? delta.changes.filter((c) => c.entity === 'superagentThread').map((c) => c.entityId)
        : []
    expect(ids(mine)).toEqual([id])
    expect(ids(theirs)).toEqual([])
    // The server-only fields never leave the server.
    const value = (await threadsOf(o, ME)).get(id) as Record<string, unknown>
    for (const field of ['harnessSessionId', 'terminalSessionId', 'watermarkItemId', 'watermarkTs'])
      expect(value).not.toHaveProperty(field)
  })
})

describe('records.superagentThread.edit', () => {
  it('renames and archives my thread, each on the path with its change row', async () => {
    const o = await makeOracle()
    const threadId = await btwThread(o)
    const id = superagentThreadRowId(ME, threadId)

    const { rows } = await expectAppliedOnPath(
      o,
      envelope('records.superagentThread.edit', { id, patch: { title: 'My question' } }, 't-1'),
      { writes: true },
    )
    expect(rows.map((r) => [r.entity, r.entityId, r.op])).toEqual([
      ['superagentThread', id, 'upsert'],
    ])
    expect((await o.store.superagent.getSuperagentThread(threadId))?.title).toBe('My question')

    await expectAppliedOnPath(
      o,
      envelope('records.superagentThread.edit', { id, patch: { archived: true } }, 't-2'),
      { writes: true },
    )
    expect((await threadsOf(o, ME)).get(id)).toMatchObject({ title: 'My question', archived: true })
  })

  it('sets a model, and a cleared one follows the settings role again', async () => {
    const o = await makeOracle()
    const set = envelope(
      'records.superagentThread.edit',
      { id: GLOBAL, patch: { model: 'm-1' } },
      'm-1',
    )
    await expectAppliedOnPath(o, set, { writes: true })
    expect((await threadsOf(o, ME)).get(GLOBAL)?.model).toBe('m-1')
    const cleared = envelope(
      'records.superagentThread.edit',
      { id: GLOBAL, patch: {}, unset: ['model'] },
      'm-2',
    )
    await expectAppliedOnPath(o, cleared, { writes: true })
    expect((await threadsOf(o, ME)).get(GLOBAL)).not.toHaveProperty('model')
  })

  it('refuses somebody else’s thread, an unknown one, a status field and archiving the global thread', async () => {
    const o = await makeOracle()
    const theirs = await btwThread(o, SOMEONE_ELSE)
    const reply = await submit(
      o,
      envelope(
        'records.superagentThread.edit',
        { id: superagentThreadRowId(SOMEONE_ELSE, theirs), patch: { title: 'mine now' } },
        'r-theirs',
      ),
    )
    expect(refusalOf(reply)?.kind).toBe('unauthorized')
    expect((await o.store.superagent.getSuperagentThread(theirs))?.title).toBe('btw · origin')

    const unknown = await submit(
      o,
      envelope(
        'records.superagentThread.edit',
        { id: superagentThreadRowId(ME, 'btw_nothing'), patch: { title: 'x' } },
        'r-unknown',
      ),
    )
    // Unknown and someone else's are one answer: no existence oracle.
    expect(refusalOf(unknown)?.kind).toBe(refusalOf(reply)?.kind)

    const status = await submit(
      o,
      envelope(
        'records.superagentThread.edit',
        { id: GLOBAL, patch: { turnRunning: true } },
        'r-st',
      ),
    )
    expect(refusalOf(status)?.kind).toBe('unauthorized')

    const archiveGlobal = await submit(
      o,
      envelope('records.superagentThread.edit', { id: GLOBAL, patch: { archived: true } }, 'r-gl'),
    )
    expect(refusalOf(archiveGlobal)?.kind).toBe('invalid')
    expect((await o.store.superagent.getSuperagentThread('global'))?.archived).toBe(false)
  })
})

describe('turn status on the record', () => {
  it('a turn sets and clears turnRunning; a failure shows until the next turn starts', async () => {
    const o = await makeOracle()
    const thread = asThreadId('global')
    const updatedAt = (await o.store.superagent.getSuperagentThread(thread))?.updatedAt
    await o.store.superagent.setTurnRunning(thread, true, { clearFailure: true })
    expect((await threadsOf(o, ME)).get(GLOBAL)?.turnRunning).toBe(true)
    // Status leaves the conversation order alone.
    expect((await o.store.superagent.getSuperagentThread(thread))?.updatedAt).toBe(updatedAt)

    const failure = { at: '2026-11-09T00:00:00.000Z', message: 'failed: offline', userText: 'hi' }
    await o.store.superagent.setTurnFailure(thread, failure)
    await o.store.superagent.setTurnRunning(thread, false)
    expect((await threadsOf(o, ME)).get(GLOBAL)).toMatchObject({
      turnRunning: false,
      lastTurnFailure: failure,
    })

    // The next turn starts: the failure goes.
    await o.store.superagent.setTurnRunning(thread, true, { clearFailure: true })
    expect((await threadsOf(o, ME)).get(GLOBAL)).toMatchObject({
      turnRunning: true,
      lastTurnFailure: null,
    })
  })
})

// ---------------------------------------------------------------------------
// The boot truth
// ---------------------------------------------------------------------------

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

async function feedFixture() {
  const store = await openTestStore(':memory:')
  stores.push(store)
  const policy = makeFeedVisibility({
    store,
    audiencesFor: (kind, ids) => store.grants.visibilityAudiencesFor(kind, ids),
    authorizationRevision: () => store.grants.visibilityRevision(),
  })
  const authority = new Authority({
    store: store.sync,
    now: () => 1_000,
    transact: async (fn) => await store.transact(fn),
    visibility: new GrantEdgeVisibilityPolicy(policy.state, new NoDelegationsGranted()),
    anchors: policy.anchors,
  })
  const writer = {
    reconcile: async (
      entity: Parameters<Authority['reconcile']>[0],
      rows: { id: string; value: unknown }[],
    ) => await authority.reconcile(entity, rows),
  }
  return { store, authority, writer }
}

const pendingTurn = (threadId: string): Omit<PendingSuperagentTurnRow, 'createdAt'> => ({
  turnId: `turn-${threadId}`,
  ownerUserId: ME,
  threadId: asThreadId(threadId),
  podiumSessionId: asSessionId(`sess-${threadId}`),
  firstTurn: true,
  payload: { agent: 'codex', cwd: '/', prompt: 'p' } as PendingSuperagentTurnRow['payload'],
})

describe('the boot reconcile', () => {
  it('a restart mid-turn clears turnRunning unless a pending turn still holds the thread', async () => {
    const { store, authority, writer } = await feedFixture()
    for (const id of ['btw_preparing', 'btw_dispatched']) {
      await store.superagent.upsertSuperagentThread({ id, ownerUserId: ME, kind: 'btw' })
      await store.superagent.setTurnRunning(asThreadId(id), true)
    }
    // Only the dispatched turn reached its durable pending row before the stop.
    await store.superagent.putPendingTurn(pendingTurn('btw_dispatched'))

    await reconcileSuperagentThreads(writer, store)
    expect((await store.superagent.getSuperagentThread('btw_preparing'))?.turnRunning).toBe(false)
    expect((await store.superagent.getSuperagentThread('btw_dispatched'))?.turnRunning).toBe(true)
    const records = new Map(
      (await authority.bootstrap(principal(ME))).changes
        .filter((c) => c.entity === 'superagentThread' && c.op === 'upsert')
        .map((c) => [c.entityId, (c as { value: SuperagentThreadWire }).value]),
    )
    expect(records.get(superagentThreadRowId(ME, 'btw_preparing'))?.turnRunning).toBe(false)
    expect(records.get(superagentThreadRowId(ME, 'btw_dispatched'))?.turnRunning).toBe(true)
    // Every member's global thread is made by the server, not by a read.
    expect(records.get(GLOBAL)?.kind).toBe('global')

    // A restart appends nothing new.
    const head = await authority.cursor()
    await reconcileSuperagentThreads(writer, store)
    expect(await authority.cursor()).toBe(head)
  })
})
