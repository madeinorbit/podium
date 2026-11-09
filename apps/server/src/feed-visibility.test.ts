import {
  asIssueId,
  asMachineId,
  asSessionId,
  asUserId,
  checkoutRowId,
  interactionRowId,
  machineAccessRowId,
  issueUserStateRowId,
  messageRecordRowId,
  subscriptionRowId,
} from '@podium/model'
import { asCapabilityRef, asDeviceId, type Principal } from '@podium/protocol'
import {
  Authority,
  type EntityRef,
  GrantEdgeVisibilityPolicy,
  NoDelegationsGranted,
  type VisibilityAnchorPort,
} from '@podium/sync'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { makeFeedVisibility } from './feed-visibility'
import type { FeedVisibilityStore, IssueRow, SessionRow } from './hot-path-ports'
import type { SessionStore } from './store'
import type { GrantRow } from './store/grants'
import { openTestStore } from './test-support/open-test-store'

/** One row's edge through the batched anchor port. */
const edgeOf = async (anchors: VisibilityAnchorPort, ref: EntityRef) =>
  (await anchors.visibilityEdges([ref]))[0] ?? null

const owner = asUserId('owner')
const reader = asUserId('reader')
const stranger = asUserId('stranger')
const revoked = asUserId('revoked')
const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

async function fixture() {
  const store = await openTestStore(':memory:')
  stores.push(store)
  const issue = { id: asIssueId('shared'), ownerUserId: owner } as IssueRow
  const session = {
    id: asSessionId('shared'),
    ownerUserId: owner,
    issueId: 'shared',
    resumeValue: 'conversation',
  } as SessionRow
  const rows: FeedVisibilityStore = {
    issues: {
      getIssue: async () => issue,
      getIssues: async () => new Map([[issue.id, issue]]),
      liveWorktreeIssuesOnMachines: async () => new Map(),
    },
    sessions: {
      getSessions: async () => new Map([[session.id, session]]),
      findSessionsByResumeValues: async () => new Map([['conversation', session]]),
      findSessionsByIssueIds: async (ids) => (ids.includes(issue.id) ? [session] : []),
    },
    shipping: {
      issueIdsForOrders: async () => new Map(),
      laneMemberIssueIdsMany: async (ids) => new Map([...ids].map((id) => [id, []])),
      ordersByIds: async () => [],
      orderIdsForIssues: async () => [],
    },
    automations: { ownersOf: async () => new Map(), runOwnersOf: async () => new Map() },
    // The workflow kinds' owners (POD-6676): one workflow, its revision, a
    // binding and a run, all the owner's.
    workflows: {
      visibilityFacts: async () => ({
        workflows: new Map([['shared', { ownerUserId: owner, scope: 'repository' as const }]]),
        revisions: new Map([
          ['wfr_shared', { workflowId: 'shared', ownerUserId: owner, scope: 'repository' as const }],
        ]),
        bindings: new Map([['issue:shared', owner]]),
        runs: new Map([['shared', owner]]),
      }),
    },
    effects: {
      // Three effects: one on the shared issue, one on the shared session, one on
      // a machine; each created by the stranger's neighbour `creator`.
      audiencesOf: async (ids) => new Map([...EFFECT_AUDIENCES].filter(([id]) => ids.includes(id))),
      liveOnTargets: async (targets) =>
        [...EFFECT_AUDIENCES]
          .filter(([, audience]) =>
            targets.some(
              (target) => target.kind === audience.targetKind && target.id === audience.targetId,
            ),
          )
          .map(([id, audience]) => ({
            id,
            targetKind: audience.targetKind,
            targetId: audience.targetId,
          })),
    },
    users: {
      activeAdminIds: async () => {
        adminReads.count += 1
        return new Set([firstAdmin, secondAdmin])
      },
    },
    grants: store.grants,
    sync: store.sync,
    checkouts: store.checkouts,
  }
  const policy = makeFeedVisibility({
    store: rows,
    audiencesFor: (kind, ids) => store.grants.visibilityAudiencesFor(kind, ids),
    authorizationRevision: () => store.grants.visibilityRevision(),
  })
  const grant = async (kind: string, grantee: string, verb: GrantRow['verb']) =>
    store.grants.upsert({
      resourceKind: kind,
      resourceId: 'shared',
      grantee,
      verb,
      owner,
      visibility: 'personal',
      createdAt: '2026-09-11T00:00:00Z',
      actorKind: 'user',
      actorId: owner,
      onBehalfOf: owner,
    })
  return { store, policy, grant }
}
const creator = asUserId('creator')
const firstAdmin = asUserId('first-admin')
const secondAdmin = asUserId('second-admin')
/** How many times a pass read the admin ids; it reads them only for instance kinds. */
const adminReads = { count: 0 }
const EFFECT_AUDIENCES = new Map([
  [
    'eff_issue',
    { kind: 'issue.merge', targetKind: 'issue', targetId: 'shared', createdBy: creator },
  ],
  [
    'eff_session',
    { kind: 'session.interrupt', targetKind: 'session', targetId: 'shared', createdBy: creator },
  ],
  [
    'eff_machine',
    { kind: 'machine.scan', targetKind: 'machine', targetId: 'm1', createdBy: creator },
  ],
  [
    'eff_update',
    { kind: 'server.update', targetKind: 'machine', targetId: 'host', createdBy: firstAdmin },
  ],
  [
    'eff_move',
    { kind: 'server.move', targetKind: 'machine', targetId: 'm2', createdBy: firstAdmin },
  ],
] as const)
const refs: EntityRef[] = [
  { entity: 'issueProjection', entityId: 'shared' },
  { entity: 'session', entityId: 'shared' },
  { entity: 'conversation', entityId: 'conversation' },
]

describe('feed visibility grant semantics', () => {
  it('keeps issue user-state private in bootstrap and delta even when the issue is shared', async () => {
    const { store, policy, grant } = await fixture()
    await grant('issue', reader, 'read')
    const authority = new Authority({
      store: store.sync,
      now: () => 1_000,
      transact: async (fn) => await store.transact(fn),
      visibility: new GrantEdgeVisibilityPolicy(policy.state, new NoDelegationsGranted()),
      anchors: policy.anchors,
    })
    const principal = (user: typeof owner): Principal => ({
      kind: 'user',
      user,
      device: asDeviceId(`device:${user}`),
      capability: asCapabilityRef(`cap:${user}`),
    })
    const id = asIssueId('shared')
    const cursor = await authority.cursor()
    await authority.capture(
      [owner, reader].map((userId) => ({
        entity: 'issueUserState',
        entityId: issueUserStateRowId(userId, id),
        op: 'upsert' as const,
        value: {
          userId,
          entityId: id,
          readAt: userId === owner ? 'owner-read' : null,
          tuckedAt: null,
          pinned: userId === owner,
        },
      })),
    )
    for (const user of [owner, reader]) {
      const bootstrap = await authority.bootstrap(principal(user))
      expect(
        bootstrap.changes.filter((c) => c.entity === 'issueUserState').map((c) => c.entityId),
      ).toEqual([issueUserStateRowId(user, id)])
      const delta = await authority.changesSince(cursor, principal(user))
      expect(delta?.kind).toBe('batch')
      if (delta?.kind !== 'batch') throw new Error('expected delta')
      expect(
        delta.changes.filter((c) => c.entity === 'issueUserState').map((c) => c.entityId),
      ).toEqual([issueUserStateRowId(user, id)])
    }
    expect((await authority.bootstrap(principal(stranger))).changes).toEqual([])
    expect(policy.state.keyedUserOf({ entity: 'issueUserState', entityId: 'malformed' })).toBeNull()
  })

  it('git observations share the issue audience and ride its grant/revoke subjects', async () => {
    const { policy, grant } = await fixture()
    const git: EntityRef = { entity: 'issueGitState', entityId: 'shared' }
    await grant('issue', reader, 'read')
    const state = await policy.state.forBootstrap!([git])
    expect(state.classOf(git.entity)).toBe('personal')
    expect(state.mayRead(owner, git)).toBe(true)
    expect(state.mayRead(reader, git)).toBe(true)
    // Every member reads every task, and its git state with it (POD-6288).
    expect(state.mayRead(stranger, git)).toBe(true)
    expect(
      (await edgeOf(policy.anchors, { entity: 'issueProjection', entityId: 'shared' }))?.subjects,
    ).toContainEqual(git)
  })
  it("effect records share their target's audience and ride its grant/revoke subjects (POD-6401)", async () => {
    const { store, policy, grant } = await fixture()
    const principalOf = (user: typeof owner): Principal => ({
      kind: 'user',
      user,
      device: asDeviceId(`device:${user}`),
      capability: asCapabilityRef(`cap:${user}`),
    })
    const authority = new Authority({
      store: store.sync,
      now: () => 1_000,
      transact: async (fn) => await store.transact(fn),
      visibility: new GrantEdgeVisibilityPolicy(policy.state, new NoDelegationsGranted()),
      anchors: policy.anchors,
    })
    // The merge's record is written before anyone is let in, and does not change after.
    await authority.capture([
      {
        entity: 'issueProjection',
        entityId: 'shared',
        op: 'upsert',
        value: { id: 'shared', revision: 1 },
      },
      { entity: 'effect', entityId: 'eff_issue', op: 'upsert', value: { id: 'eff_issue' } },
    ])
    const cursor = await authority.cursor()
    await grant('issue', reader, 'read')
    await authority.capture([
      {
        entity: 'issueProjection',
        entityId: 'shared',
        op: 'upsert',
        value: { id: 'shared', revision: 2 },
      },
    ])
    const delta = await authority.changesSince(cursor, principalOf(reader))
    if (delta?.kind !== 'batch') throw new Error('expected a delta batch')
    // The grant hands the reader the issue's record at once, not at its next
    // change; the session's, which the issue grant does not open, is an evict.
    expect(
      delta.changes
        .filter((change) => change.entity === 'effect')
        .map((change) => [change.entityId, change.op]),
    ).toEqual([
      ['eff_issue', 'upsert'],
      ['eff_session', 'evict'],
    ])
    // A device that bootstraps after the grant gets the issue's record too.
    expect(
      (await authority.bootstrap(principalOf(reader))).changes
        .filter((change) => change.entity === 'effect')
        .map((change) => change.entityId),
    ).toEqual(['eff_issue'])

    // The issue's records and its session's ride the issue's edge, and no other target's.
    const effectsOf = async () =>
      (
        await edgeOf(policy.anchors, { entity: 'issueProjection', entityId: 'shared' })
      )?.subjects.filter((ref) => ref.entity === 'effect')
    expect(await effectsOf()).toEqual([
      { entity: 'effect', entityId: 'eff_issue' },
      { entity: 'effect', entityId: 'eff_session' },
    ])
    // Each subject is still decided per reader: the issue grant opens the issue's
    // record, not the session's.
    const subjects = (await effectsOf()) ?? []
    let state = await policy.state.forBatch!(subjects)
    expect(subjects.map((ref) => state.mayRead(reader, ref))).toEqual([true, false])
    await grant('session', reader, 'read')
    state = await policy.state.forBatch!(subjects)
    expect(subjects.map((ref) => state.mayRead(reader, ref))).toEqual([true, true])

    // A revoke keeps the reader in the edge's audience with the same subjects, so
    // the records leave their devices with the issue.
    await store.grants.remove('issue', 'shared', reader, 'read')
    const revokedEdge = await edgeOf(policy.anchors, {
      entity: 'issueProjection',
      entityId: 'shared',
    })
    expect(revokedEdge?.audience).toEqual([reader])
    expect(revokedEdge?.subjects).toContainEqual({ entity: 'effect', entityId: 'eff_issue' })
    state = await policy.state.forBatch!(subjects)
    expect(state.mayRead(reader, subjects[0]!)).toBe(false)
    // On the live feed the issue's next write takes the record off the reader's
    // devices; the session's stays, through its own grant.
    const beforeRevokeWrite = await authority.cursor()
    await authority.capture([
      {
        entity: 'issueProjection',
        entityId: 'shared',
        op: 'upsert',
        value: { id: 'shared', revision: 3 },
      },
    ])
    const revokedDelta = await authority.changesSince(beforeRevokeWrite, principalOf(reader))
    if (revokedDelta?.kind !== 'batch') throw new Error('expected a delta batch')
    expect(
      revokedDelta.changes
        .filter((change) => change.entity === 'effect' && change.entityId === 'eff_issue')
        .map((change) => change.op),
    ).toEqual(['evict'])
    expect(
      (await authority.bootstrap(principalOf(reader))).changes.some(
        (change) => change.entity === 'effect' && change.entityId === 'eff_issue',
      ),
    ).toBe(false)
  })
  it('an effect is read by its creator and by the readers of its target (POD-6357)', async () => {
    const { policy, grant } = await fixture()
    await grant('issue', reader, 'read')
    const effects: EntityRef[] = ['eff_issue', 'eff_session', 'eff_machine', 'eff_gone'].map(
      (entityId) => ({ entity: 'effect', entityId }),
    )
    for (const prepare of [policy.state.forBootstrap!, policy.state.forBatch!]) {
      const state = await prepare(effects)
      expect(state.classOf('effect')).toBe('personal')
      const readable = (user: typeof owner) =>
        effects.filter((ref) => state.mayRead(user, ref)).map((ref) => ref.entityId)
      expect(readable(creator)).toEqual(['eff_issue', 'eff_session', 'eff_machine'])
      expect(readable(owner)).toEqual(['eff_issue', 'eff_session'])
      // A read grant on the issue only: the session's grant is not there.
      expect(readable(reader)).toEqual(['eff_issue'])
      expect(readable(stranger)).toEqual([])
    }
  })

  it('a software update or a server move is read by every admin, never by a member (POD-6358)', async () => {
    const { policy } = await fixture()
    const instance: EntityRef[] = ['eff_update', 'eff_move'].map((entityId) => ({
      entity: 'effect',
      entityId,
    }))
    for (const prepare of [policy.state.forBootstrap!, policy.state.forBatch!]) {
      const state = await prepare(instance)
      const readable = (user: typeof owner) =>
        instance.filter((ref) => state.mayRead(user, ref)).map((ref) => ref.entityId)
      // The admin who started them, and an admin who did not.
      expect(readable(firstAdmin)).toEqual(['eff_update', 'eff_move'])
      expect(readable(secondAdmin)).toEqual(['eff_update', 'eff_move'])
      // A member, even one who reads the machine's other records, does not.
      expect(readable(creator)).toEqual([])
      expect(readable(stranger)).toEqual([])
    }
  })

  it('reads the admins only for a batch that holds an instance-wide effect (POD-6358)', async () => {
    const { policy } = await fixture()
    adminReads.count = 0
    await policy.state.forBatch!([{ entity: 'effect', entityId: 'eff_issue' }])
    expect(adminReads.count).toBe(0)
    await policy.state.forBatch!([{ entity: 'effect', entityId: 'eff_update' }])
    expect(adminReads.count).toBe(1)
  })

  it('a workflow, its revisions, a binding and a run are read by their owner, a read grantee and the admins (POD-6676)', async () => {
    const { policy, grant } = await fixture()
    await grant('workflow-definition', reader, 'read')
    const rows: EntityRef[] = [
      { entity: 'workflow', entityId: 'shared' },
      { entity: 'workflowRevision', entityId: 'wfr_shared' },
      { entity: 'workflowBinding', entityId: 'issue:shared' },
      { entity: 'workflowRun', entityId: 'shared' },
      { entity: 'workflow', entityId: 'wf_gone' },
    ]
    const all = [
      'workflow:shared',
      'workflowRevision:wfr_shared',
      'workflowBinding:issue:shared',
      'workflowRun:shared',
    ]
    for (const prepare of [policy.state.forBootstrap!, policy.state.forBatch!]) {
      const state = await prepare(rows)
      for (const kind of ['workflow', 'workflowRevision', 'workflowBinding', 'workflowRun'] as const) {
        expect(state.classOf(kind)).toBe('personal')
      }
      const readable = (user: typeof owner) =>
        rows.filter((ref) => state.mayRead(user, ref)).map((ref) => `${ref.entity}:${ref.entityId}`)
      expect(readable(owner)).toEqual(all)
      expect(readable(firstAdmin)).toEqual(all)
      // A read grant on the definition reaches it and its revisions, never the
      // runs or the bindings, which are owned in their own right.
      expect(readable(reader)).toEqual(['workflow:shared', 'workflowRevision:wfr_shared'])
      expect(readable(stranger)).toEqual([])
    }
  })

  it('a profile is instance substrate; a subscription follows its subscriber (POD-6676)', async () => {
    const { policy } = await fixture()
    const subs: EntityRef[] = [
      { entity: 'subscription', entityId: subscriptionRowId('session', 'shared', 'sub_s') },
      { entity: 'subscription', entityId: subscriptionRowId('issue', 'shared', 'sub_i') },
      { entity: 'subscription', entityId: 'not a row id' },
    ]
    for (const prepare of [policy.state.forBootstrap!, policy.state.forBatch!]) {
      const state = await prepare(subs)
      expect(state.classOf('agentProfile')).toBe('deployment-substrate')
      expect(state.classOf('subscription')).toBe('personal')
      const readable = (user: typeof owner) =>
        subs.filter((ref) => state.mayRead(user, ref)).map((ref) => ref.entityId)
      // A session's subscription is its owner's; a task's every member's, as
      // the task is (design §1.11).
      expect(readable(owner)).toEqual([subs[0]!.entityId, subs[1]!.entityId])
      expect(readable(stranger)).toEqual([subs[1]!.entityId])
    }
  })

  it('reads grants through its store port but cannot write them', () => {
    expectTypeOf<FeedVisibilityStore['grants']>().toHaveProperty('listForResources')
    expectTypeOf<FeedVisibilityStore['grants']>().not.toHaveProperty('upsert')
    expectTypeOf<FeedVisibilityStore['grants']>().not.toHaveProperty('remove')
  })

  // Issue grants are inert history (design §4.1, POD-6288): writing or
  // revoking one changes nobody's read of the task.
  it('decides task reads without issue grants, before, during and after a revocation', async () => {
    const { store, policy, grant } = await fixture()
    expect(await policy.mayReadIssue(reader, asIssueId('shared'))).toBe(true)
    await store.transact(async () => {
      await grant('issue', reader, 'read')
    })
    expect(await policy.mayReadIssue(reader, asIssueId('shared'))).toBe(true)
    await store.transact(async () => {
      await store.grants.remove('issue', 'shared', reader, 'read')
    })
    expect(await policy.mayReadIssue(reader, asIssueId('shared'))).toBe(true)
    expect(await policy.mayReadIssue(stranger, asIssueId('shared'))).toBe(true)
  })

  it.each([
    'read',
    'write',
    'manage',
  ] as const)('reads %s-granted, stranger and revoked tasks alike, and sessions by owner only', async (verb) => {
    const { store, policy, grant } = await fixture()
    await grant('issue', reader, verb)
    await grant('session', reader, verb)
    await grant('issue', revoked, 'read')
    await grant('session', revoked, 'read')
    const revision = await policy.authorizationRevision()
    await store.grants.remove('issue', 'shared', revoked, 'read')
    await store.grants.remove('session', 'shared', revoked, 'read')
    expect(await policy.authorizationRevision()).toBeGreaterThan(revision)
    for (const prepare of [policy.state.forBootstrap!, policy.state.forBatch!]) {
      const state = await prepare(refs)
      for (const ref of refs) {
        expect(state.mayRead(owner, ref)).toBe(true)
        // A session grant is legacy and admits nobody (POD-6283); a task is
        // read by every member, grant or none (POD-6288).
        const shared = ref.entity === 'issueProjection'
        expect(state.mayRead(reader, ref)).toBe(shared)
        expect(state.mayRead(stranger, ref)).toBe(shared)
        expect(state.mayRead(revoked, ref)).toBe(shared)
      }
    }
    expect(await policy.mayReadIssue(reader, asIssueId('shared'))).toBe(true)
    expect(await policy.mayReadIssue(revoked, asIssueId('shared'))).toBe(true)
    // Revoked readers remain in the historical audience so they receive removals.
    expect(
      (await edgeOf(policy.anchors, { entity: 'issueProjection', entityId: 'shared' }))?.audience,
    ).toEqual([reader, revoked])
  })

  it('does not treat an issue or conversation grant as a session grant', async () => {
    const { policy, grant } = await fixture()
    await grant('issue', reader, 'read')
    await grant('conversation', reader, 'read')
    const state = await policy.state.forBatch!(refs)
    expect(refs.map((ref) => state.mayRead(reader, ref))).toEqual([true, false, false])
  })
})

describe('rows scoped by the session named in their id', () => {
  const ask: EntityRef = {
    entity: 'pendingInteraction',
    entityId: interactionRowId('shared', 'ixn_1'),
  }
  const sent = (senderUserId: string): EntityRef => ({
    entity: 'message',
    entityId: messageRecordRowId({ sessionId: 'shared', senderUserId, messageId: 'msg_1' }),
  })

  it('shows a blocking ask to whoever may see its session (POD-4764 found the prefetch missing)', async () => {
    const { policy, grant } = await fixture()
    // A legacy session grant: the ask stays its session owner's alone (POD-6283).
    await grant('session', reader, 'read')
    for (const prepare of [policy.state.forBootstrap!, policy.state.forBatch!]) {
      const state = await prepare([ask])
      expect([owner, reader, stranger].map((user) => state.mayRead(user, ask))).toEqual([
        true,
        false,
        false,
      ])
    }
  })

  it('shows a chat message to its sender and the session owner, and to no other reader', async () => {
    const { policy, grant } = await fixture()
    await grant('session', reader, 'read')
    for (const prepare of [policy.state.forBootstrap!, policy.state.forBatch!]) {
      const fromStranger = sent(stranger)
      const state = await prepare([fromStranger])
      expect(policy.state.classOf('message')).toBe('personal')
      expect([owner, reader, stranger].map((user) => state.mayRead(user, fromStranger))).toEqual([
        true,
        false,
        true,
      ])
    }
  })

  it('refuses a message row whose id does not parse', async () => {
    const { policy } = await fixture()
    const broken: EntityRef = { entity: 'message', entityId: 'not-a-row-id' }
    const state = await policy.state.forBatch!([broken])
    expect(state.mayRead(owner, broken)).toBe(false)
  })
})

/**
 * THE ANCHOR EDGE IS KEYED ON THE NORMALIZED RECORD (POD-4971, step 5c of
 * POD-4949). A share commits through the issue's own write, and that write's
 * change re-admits the issue's subjects to its audience. Until this step the
 * edge listened for the old record (`issue`), which stops being sent at step 7;
 * keyed there, a share would then re-admit nothing. Each arm captures ONE issue
 * kind into a real Authority and reads the grantee's delta.
 */
describe('the issue anchor edge reads the normalized record', () => {
  it('a share re-admits the normalized issue and names only current subjects', async () => {
    const { store, policy, grant } = await fixture()
    const authority = new Authority({
      store: store.sync,
      now: () => 1_000,
      transact: async (fn) => await store.transact(fn),
      visibility: new GrantEdgeVisibilityPolicy(policy.state, new NoDelegationsGranted()),
      anchors: policy.anchors,
    })
    await authority.capture([
      {
        entity: 'issueProjection',
        entityId: 'shared',
        op: 'upsert',
        value: { id: 'shared', revision: 1 },
      },
    ])
    const cursor = await authority.cursor()
    await grant('issue', reader, 'read')
    await authority.capture([
      {
        entity: 'issueProjection',
        entityId: 'shared',
        op: 'upsert',
        value: { id: 'shared', revision: 2 },
      },
    ])
    const delta = await authority.changesSince(cursor, {
      kind: 'user',
      user: reader,
      device: asDeviceId('reader-device'),
      capability: asCapabilityRef('reader-cap'),
    })
    if (delta?.kind !== 'batch') throw new Error('expected a delta batch')
    expect(delta.changes.filter((change) => change.entity === 'issueProjection')).toHaveLength(2)
    const edge = await edgeOf(policy.anchors, {
      entity: 'issueProjection',
      entityId: 'shared',
    })
    expect(edge?.audience).toEqual([reader])
    expect(edge?.subjects.slice(0, 2)).toEqual([
      { entity: 'issueProjection', entityId: 'shared' },
      { entity: 'issueGitState', entityId: 'shared' },
    ])
    expect(edge?.subjects.some((ref) => String(ref.entity) === 'issue')).toBe(false)
  })
})

// A machine's records (POD-6644): each member's access row is theirs alone, and
// a checkout reaches only the members holding `use` on its machine.
describe('machine access and checkout rows', () => {
  const machineGrant = (store: SessionStore, grantee: string, verb: GrantRow['verb'], custody = false) =>
    store.grants.upsert({
      resourceKind: 'machine',
      resourceId: 'm1',
      grantee,
      verb,
      owner,
      visibility: 'owned-compute',
      createdAt: '2026-11-09T00:00:00Z',
      actorKind: 'user',
      actorId: owner,
      onBehalfOf: owner,
      ...(custody ? { custody: true } : {}),
    })

  it('an access row is keyed to its member, and a checkout needs use on the machine', async () => {
    const { store, policy } = await fixture()
    await machineGrant(store, owner, 'manage', true)
    await machineGrant(store, owner, 'use')
    await machineGrant(store, reader, 'use')
    await machineGrant(store, stranger, 'see')

    const access = { entity: 'machineAccess' as const, entityId: machineAccessRowId(reader, asMachineId('m1')) }
    expect(policy.state.classOf('machineAccess')).toBe('per-user-state')
    expect(policy.state.keyedUserOf(access)).toBe(reader)
    expect(policy.state.keyedUserOf({ entity: 'machineAccess', entityId: 'malformed' })).toBeNull()

    const checkout = {
      entity: 'checkout' as const,
      entityId: checkoutRowId(asMachineId('m1'), '/home/u/podium'),
    }
    const state = await policy.state.forBatch!([checkout])
    expect(state.classOf('checkout')).toBe('personal')
    expect(state.mayRead(owner, checkout)).toBe(true)
    expect(state.mayRead(reader, checkout)).toBe(true)
    // `see` alone is not what is checked out there (ADR 9), and no grant is nothing.
    expect(state.mayRead(stranger, checkout)).toBe(false)
    expect(state.mayRead(revoked, checkout)).toBe(false)
  })

  // Coordinator decision (POD-5620, 2026-11-09): a registered root is read
  // with MANAGE or USE, a worktree only with USE. Admins MANAGE every machine.
  it('a root reaches its managers and admins, a worktree only its users', async () => {
    const { store, policy } = await fixture()
    const m1 = asMachineId('m1')
    await machineGrant(store, owner, 'manage', true)
    await machineGrant(store, reader, 'use')
    await machineGrant(store, stranger, 'manage')
    const row = (path: string, root: string) => ({
      machineId: m1,
      path,
      root,
      kind: path === root ? ('repository' as const) : ('worktree' as const),
      repoId: null,
      branch: 'main',
      originUrl: null,
      locked: false,
      prunable: false,
    })
    await store.checkouts.apply(
      [row('/home/u/podium', '/home/u/podium'), row('/home/u/.worktrees/feature', '/home/u/podium')],
      [],
      '2026-11-09T00:00:00Z',
    )
    const root = { entity: 'checkout' as const, entityId: checkoutRowId(m1, '/home/u/podium') }
    const worktree = { entity: 'checkout' as const, entityId: checkoutRowId(m1, '/home/u/.worktrees/feature') }
    // A removed checkout (no row) is read as a worktree: no path leaks to a manager.
    const gone = { entity: 'checkout' as const, entityId: checkoutRowId(m1, '/home/u/gone') }
    const state = await policy.state.forBatch!([root, worktree, gone])
    for (const manager of [owner, stranger, firstAdmin]) {
      expect(state.mayRead(manager, root), manager).toBe(true)
      expect(state.mayRead(manager, worktree), manager).toBe(false)
      expect(state.mayRead(manager, gone), manager).toBe(false)
    }
    expect(state.mayRead(reader, root)).toBe(true)
    expect(state.mayRead(reader, worktree)).toBe(true)
    expect(state.mayRead(revoked, root)).toBe(false)
  })

  it('a use grant with nobody in custody admits nobody', async () => {
    const { store, policy } = await fixture()
    await machineGrant(store, reader, 'use')
    const checkout = {
      entity: 'checkout' as const,
      entityId: checkoutRowId(asMachineId('m1'), '/home/u/podium'),
    }
    const state = await policy.state.forBatch!([checkout])
    expect(state.mayRead(reader, checkout)).toBe(false)
  })

  it('a member whose access row moved is re-sent that machine’s checkouts', async () => {
    const { store, policy } = await fixture()
    await store.machines.upsertMachine({
      id: 'm1',
      name: 'one',
      hostname: 'one',
      tokenHash: 'x',
      ownerUserId: owner,
    })
    await store.checkouts.apply(
      [
        {
          machineId: asMachineId('m1'),
          path: '/home/u/podium',
          root: '/home/u/podium',
          kind: 'repository',
          repoId: null,
          branch: 'main',
          originUrl: null,
          locked: false,
          prunable: false,
        },
      ],
      [],
      '2026-11-09T00:00:00Z',
    )
    const edge = await edgeOf(policy.anchors, {
      entity: 'machineAccess',
      entityId: machineAccessRowId(reader, asMachineId('m1')),
    })
    expect(edge?.audience).toEqual([reader])
    expect(edge?.subjects).toEqual([
      { entity: 'checkout', entityId: checkoutRowId(asMachineId('m1'), '/home/u/podium') },
    ])
  })
})
