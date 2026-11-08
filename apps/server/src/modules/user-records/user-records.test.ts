/**
 * PINS, TAB ORDERS AND PERSONAL PREFERENCES AS SYNCED PER-USER RECORDS
 * (POD-6673).
 *
 * Through the real composed server over `sync.submit` (the path the apps'
 * outbox takes), then through the Authority's feed with the real visibility
 * policy: the owner's devices receive the rows, nobody else does. And the boot
 * back-fill puts rows stored before this build onto the log.
 */

import {
  asUserId,
  firstAdminMemberId,
  pinRowId,
  tabOrderRowId,
  userPreferencesRowId,
} from '@podium/model'
import { asCapabilityRef, asDeviceId, type Principal } from '@podium/protocol'
import { Authority, GrantEdgeVisibilityPolicy, NoDelegationsGranted } from '@podium/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFeedVisibility } from '../../feed-visibility'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { envelope, expectAppliedOnPath, rowsOf, submit } from '../sync-write/outbox-test-support'
import { reconcileUserRecords } from './reconcile'

afterEach(() => disposeOracles())

const ME = firstAdminMemberId()
const SOMEONE_ELSE = asUserId('mem_0000000000000000000000000000')

const refusalOf = (reply: Awaited<ReturnType<typeof submit>>) =>
  reply.outcome === 'rejected' ? reply.refusal : undefined

async function shellSession(o: Oracle): Promise<string> {
  return (await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })).sessionId
}

describe('records.pin', () => {
  it('a create pins and a remove unpins, each on the path with its change row', async () => {
    const o = await makeOracle()
    const id = pinRowId(ME, 'repo', '/repo/a')
    const fields = { userId: ME, kind: 'repo', entityId: '/repo/a' }

    const { rows } = await expectAppliedOnPath(
      o,
      envelope('records.pin.create', { id, fields }, 'pin-1'),
      { writes: true },
    )
    expect(rows.map((r) => [r.entity, r.entityId, r.op])).toEqual([['pin', id, 'upsert']])
    expect(await o.store.sessions.pinnedAt(ME, 'repo', '/repo/a')).toEqual(expect.any(String))

    await expectAppliedOnPath(o, envelope('records.pin.remove', { id }, 'pin-2'), { writes: true })
    expect(await o.store.sessions.pinnedAt(ME, 'repo', '/repo/a')).toBeUndefined()
  })

  it('pinning what is pinned keeps the first pin, and unpinning nothing writes nothing', async () => {
    const o = await makeOracle()
    const id = pinRowId(ME, 'worktree', '/w')
    const fields = { userId: ME, kind: 'worktree', entityId: '/w' }
    await expectAppliedOnPath(o, envelope('records.pin.create', { id, fields }, 'p-a'), {
      writes: true,
    })
    const first = await o.store.sessions.pinnedAt(ME, 'worktree', '/w')

    const again = await submit(o, envelope('records.pin.create', { id, fields }, 'p-b'))
    expect(again.outcome).toBe('applied')
    expect(await o.store.sessions.pinnedAt(ME, 'worktree', '/w')).toBe(first)
    expect(await rowsOf(o, 'p-b')).toEqual([])

    const nothing = pinRowId(ME, 'worktree', '/never')
    expect((await submit(o, envelope('records.pin.remove', { id: nothing }, 'p-c'))).outcome).toBe(
      'applied',
    )
    expect(await rowsOf(o, 'p-c')).toEqual([])
  })

  it('refuses somebody else’s pin, and fields that disagree with the id', async () => {
    const o = await makeOracle()
    const theirs = pinRowId(SOMEONE_ELSE, 'repo', '/r')
    const reply = await submit(
      o,
      envelope(
        'records.pin.create',
        { id: theirs, fields: { userId: SOMEONE_ELSE, kind: 'repo', entityId: '/r' } },
        'p-theirs',
      ),
    )
    expect(refusalOf(reply)?.kind).toBe('unauthorized')
    expect(await o.store.sessions.pinnedAt(SOMEONE_ELSE, 'repo', '/r')).toBeUndefined()

    const mismatched = await submit(
      o,
      envelope(
        'records.pin.create',
        {
          id: pinRowId(ME, 'repo', '/r'),
          fields: { userId: ME, kind: 'repo', entityId: '/other' },
        },
        'p-mismatch',
      ),
    )
    expect(refusalOf(mismatched)?.kind).toBe('invalid')
    expect(await o.store.sessions.pinnedAt(ME, 'repo', '/other')).toBeUndefined()
  })

  it('a panel pin names a session the caller may read', async () => {
    const o = await makeOracle()
    const sessionId = await shellSession(o)
    const id = pinRowId(ME, 'panel', sessionId)
    await expectAppliedOnPath(
      o,
      envelope(
        'records.pin.create',
        { id, fields: { userId: ME, kind: 'panel', entityId: sessionId } },
        'p-panel',
      ),
      { writes: true },
    )
    const unknown = pinRowId(ME, 'panel', 'sess-nobody-has')
    const reply = await submit(
      o,
      envelope(
        'records.pin.create',
        { id: unknown, fields: { userId: ME, kind: 'panel', entityId: 'sess-nobody-has' } },
        'p-ghost',
      ),
    )
    expect(refusalOf(reply)?.kind).toBe('unauthorized')
    // A refusal is an audit fact too.
    expect(
      (await o.store.settingsAudit.list()).filter(
        (row) => row.command === 'records.userPreferences.edit',
      ),
    ).toEqual([expect.objectContaining({ outcome: 'refused', actorId: ME })])
  })
})

describe('records.tabOrder', () => {
  it('an edit sets the whole order, a later one replaces it, and an empty one removes it', async () => {
    const o = await makeOracle()
    const a = await shellSession(o)
    const b = await shellSession(o)
    const id = tabOrderRowId(ME, '/w')

    await expectAppliedOnPath(
      o,
      envelope('records.tabOrder.edit', { id, patch: { sessionIds: [a, b] } }, 't-1'),
      { writes: true },
    )
    await expectAppliedOnPath(
      o,
      envelope('records.tabOrder.edit', { id, patch: { sessionIds: [b, a] } }, 't-2'),
      { writes: true },
    )
    expect(await o.store.sessions.tabOrder(ME, '/w')).toEqual([b, a])

    const { rows } = await expectAppliedOnPath(
      o,
      envelope('records.tabOrder.edit', { id, patch: { sessionIds: [] } }, 't-3'),
      { writes: true },
    )
    expect(rows.map((r) => r.op)).toEqual(['remove'])
    expect(await o.store.sessions.tabOrder(ME, '/w')).toBeUndefined()
  })

  it('refuses an order naming a session the caller cannot read, and somebody else’s row', async () => {
    const o = await makeOracle()
    const a = await shellSession(o)
    const ghost = await submit(
      o,
      envelope(
        'records.tabOrder.edit',
        { id: tabOrderRowId(ME, '/w'), patch: { sessionIds: [a, 'sess-ghost'] } },
        't-ghost',
      ),
    )
    expect(refusalOf(ghost)?.kind).toBe('unauthorized')
    const theirs = await submit(
      o,
      envelope(
        'records.tabOrder.edit',
        { id: tabOrderRowId(SOMEONE_ELSE, '/w'), patch: { sessionIds: [a] } },
        't-theirs',
      ),
    )
    expect(refusalOf(theirs)?.kind).toBe('unauthorized')
    expect(await o.store.sessions.tabOrder(ME, '/w')).toBeUndefined()
  })
})

describe('records.userPreferences', () => {
  const id = userPreferencesRowId(ME)

  it('an edit writes the leaves it names, publishes the whole record, and a reset clears a leaf', async () => {
    const o = await makeOracle()
    const { rows } = await expectAppliedOnPath(
      o,
      envelope(
        'records.userPreferences.edit',
        { id, patch: { 'sidebar.repoSort': 'custom', 'roles.coding.model': 'opus' } },
        'u-1',
      ),
      { writes: true },
    )
    expect(rows.map((r) => [r.entity, r.entityId])).toEqual([['userPreferences', id]])
    // A second device changes a different leaf: neither overwrites the other.
    await expectAppliedOnPath(
      o,
      envelope(
        'records.userPreferences.edit',
        { id, patch: { 'autoContinue.enabled': true } },
        'u-2',
      ),
      { writes: true },
    )
    expect(await o.store.settings.preferenceRecordFor(ME)).toEqual({
      userId: ME,
      'sidebar.repoSort': 'custom',
      'roles.coding.model': 'opus',
      'autoContinue.enabled': true,
    })
    const resolved = await o.store.settings.getSettingsFor(ME)
    expect(resolved.sidebar.repoSort).toBe('custom')

    await expectAppliedOnPath(
      o,
      envelope(
        'records.userPreferences.edit',
        { id, patch: {}, unset: ['roles.coding.model'] },
        'u-3',
      ),
      { writes: true },
    )
    expect(await o.store.settings.preferenceRecordFor(ME)).not.toHaveProperty('roles.coding.model')

    // The settings audit trail keeps a row per applied write, attributed to me,
    // with what I asked for: the change log does not replace it.
    const trail = (await o.store.settingsAudit.list()).filter(
      (row) => row.command === 'records.userPreferences.edit',
    )
    expect(trail.map((row) => row.outcome)).toEqual(['applied', 'applied', 'applied'])
    expect(trail.every((row) => row.actorId === ME && row.onBehalfOf === ME)).toBe(true)
    expect(JSON.stringify(trail.map((row) => row.detail))).toContain('roles.coding.model')
  })

  it('a replay runs nothing, and a secret or an instance path is no field of the record', async () => {
    const o = await makeOracle()
    const env = envelope(
      'records.userPreferences.edit',
      { id, patch: { 'sidebar.groupByRepo': true } },
      'u-r',
    )
    await expectAppliedOnPath(o, env, { writes: true })
    const replay = await submit(o, env)
    expect(replay.outcome === 'applied' && replay.replayed).toBe(true)

    for (const path of ['apiKeys.openai', 'gitWorkflow.mergeStyle']) {
      const reply = await submit(
        o,
        envelope('records.userPreferences.edit', { id, patch: { [path]: 'x' } }, `u-${path}`),
      )
      expect(refusalOf(reply)?.kind, path).toBe('invalid')
    }
  })

  it('refuses somebody else’s record', async () => {
    const o = await makeOracle()
    const reply = await submit(
      o,
      envelope(
        'records.userPreferences.edit',
        { id: userPreferencesRowId(SOMEONE_ELSE), patch: { 'sidebar.repoSort': 'custom' } },
        'u-theirs',
      ),
    )
    expect(refusalOf(reply)?.kind).toBe('unauthorized')
  })
})

// ---------------------------------------------------------------------------
// Visibility: the owner's devices receive these rows; nobody else does
// ---------------------------------------------------------------------------

const principal = (user: string): Principal => ({
  kind: 'user',
  user: asUserId(user),
  device: asDeviceId(`device:${user}`),
  capability: asCapabilityRef(`cap:${user}`),
})

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
  return { store, authority }
}

const ALICE = asUserId('user:alice-6673')
const KINDS = new Set(['pin', 'tabOrder', 'userPreferences'])

describe('the per-user records reach their owner only', () => {
  it('my pin, order and settings are on my bootstrap and my deltas, never on another member’s', async () => {
    const o = await makeOracle()
    const authority = o.reg.changeLedger.authority
    const before = await authority.cursor()
    const sessionId = await shellSession(o)
    for (const env of [
      envelope(
        'records.pin.create',
        { id: pinRowId(ME, 'repo', '/r'), fields: { userId: ME, kind: 'repo', entityId: '/r' } },
        'v-pin',
      ),
      envelope(
        'records.tabOrder.edit',
        { id: tabOrderRowId(ME, '/w'), patch: { sessionIds: [sessionId] } },
        'v-tab',
      ),
      envelope(
        'records.userPreferences.edit',
        { id: userPreferencesRowId(ME), patch: { 'sidebar.repoSort': 'custom' } },
        'v-pref',
      ),
    ]) {
      expect((await submit(o, env)).outcome).toBe('applied')
    }
    const mine = async (user: string) =>
      (await authority.bootstrap(principal(user))).changes
        .filter((c) => KINDS.has(c.entity))
        .map((c) => c.entityId)
        .sort()

    // Positive control first: without it, the other member's empty list proves nothing.
    expect(await mine(ME)).toEqual(
      [pinRowId(ME, 'repo', '/r'), tabOrderRowId(ME, '/w'), userPreferencesRowId(ME)].sort(),
    )
    expect(await mine(SOMEONE_ELSE)).toEqual([])

    const myDelta = await authority.changesSince(before, principal(ME))
    const theirDelta = await authority.changesSince(before, principal(SOMEONE_ELSE))
    // The server writes my settings too (the superagent default it picks), so
    // the delta holds at least these three ids.
    const deltaIds =
      myDelta?.kind === 'batch'
        ? new Set(myDelta.changes.filter((c) => KINDS.has(c.entity)).map((c) => c.entityId))
        : new Set<string>()
    expect([...deltaIds].sort()).toEqual(
      [pinRowId(ME, 'repo', '/r'), tabOrderRowId(ME, '/w'), userPreferencesRowId(ME)].sort(),
    )
    expect(
      theirDelta?.kind === 'batch' && theirDelta.changes.filter((c) => KINDS.has(c.entity)),
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The back-fill: rows stored before this build reach the log at boot
// ---------------------------------------------------------------------------

describe('the boot reconcile back-fills stored rows', () => {
  it('every stored pin, order and preference becomes a log row, once', async () => {
    const { store, authority } = await feedFixture()
    await store.sessions.addPin(ALICE, 'repo', '/r', '2026-01-01T00:00:00.000Z')
    await store.sessions.setTabOrder(ALICE, '/w', ['s1', 's2'])
    await store.settings.applyPreferencePatch(ALICE, { 'sidebar.repoSort': 'custom' }, 't')
    const writer = {
      reconcile: async (
        entity: Parameters<Authority['reconcile']>[0],
        rows: { id: string; value: unknown }[],
      ) => await authority.reconcile(entity, rows),
    }

    await reconcileUserRecords(writer, store)
    const after = (await authority.bootstrap(principal(ALICE))).changes.filter((c) =>
      KINDS.has(c.entity),
    )
    expect(after.map((c) => [c.entity, c.op === 'upsert' && c.value]).sort()).toEqual(
      [
        [
          'pin',
          { userId: ALICE, kind: 'repo', entityId: '/r', pinnedAt: '2026-01-01T00:00:00.000Z' },
        ],
        ['tabOrder', { userId: ALICE, entityId: '/w', sessionIds: ['s1', 's2'] }],
        ['userPreferences', { userId: ALICE, 'sidebar.repoSort': 'custom' }],
      ].sort(),
    )

    // A restart appends nothing new.
    const head = await authority.cursor()
    await reconcileUserRecords(writer, store)
    expect(await authority.cursor()).toBe(head)
  })
})
