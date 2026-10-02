/**
 * WHO MAY READ A DELIVERY LANE (POD-4974 O2, decision 2): anyone who may read at
 * least one order queued in it. The lane's readers change when orders leave it,
 * so the reader who loses the last readable order must be EVICTED, not left
 * holding a lane that stopped updating; a grant must re-admit the lane.
 */

import { createHash } from 'node:crypto'
import {
  asIssueId,
  asMachineId,
  asRepoId,
  asShipOrderId,
  asUserId,
  firstAdminMemberId,
  type ShipLaneProjection,
  type ShipOrder,
  shipLaneId,
} from '@podium/model'
import { asCapabilityRef, asDeviceId, type Principal } from '@podium/protocol'
import {
  Authority,
  type EntityRef,
  GrantEdgeVisibilityPolicy,
  NoDelegationsGranted,
} from '@podium/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFeedVisibility } from './feed-visibility'
import { WorldIndex } from './modules/world-index'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'

const owner = asUserId('owner')
const reader = asUserId('reader')
const stranger = asUserId('stranger')
const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const PROFILE = {
  id: 'default',
  argv: ['bun', 'run', 'test'],
  cwd: 'integration-root' as const,
  timeoutMs: 60_000,
  resourceLocks: [] as string[],
}
const REPO = asRepoId('repo-1')
const LANE: EntityRef = { entity: 'shipLane', entityId: shipLaneId(REPO, 'local:main') }

const issueRow = (id: string, seq: number) => ({
  id: asIssueId(id),
  repoPath: '/r',
  seq,
  title: id,
  description: 'desc',
  ownerUserId: owner,
  visibility: 'personal' as const,
  createdByActor: firstAdminMemberId(),
  createdByOnBehalfOf: firstAdminMemberId(),
  stage: 'shipping',
  worktreePath: null,
  branch: `issue/${id}`,
  parentBranch: 'main',
  defaultAgent: 'claude-code',
  defaultModel: 'auto',
  defaultEffort: 'auto',
  machineId: asMachineId('machine-1'),
  linearId: null,
  linearIdentifier: null,
  linearUrl: null,
  activityNotes: null,
  notesUpdatedAt: null,
  suggestedStage: null,
  suggestedReason: null,
  blockedBy: [] as string[],
  dependencyNote: null,
  prUrl: null,
  priority: 2,
  type: 'task',
  assignee: null,
  parentId: null,
  design: null,
  acceptance: null,
  notes: null,
  dueAt: null,
  deferUntil: null,
  closedReason: null,
  closedAt: null,
  supersededBy: null,
  duplicateOf: null,
  pinned: false,
  estimateMin: null,
  needsHuman: false,
  humanQuestion: null,
  createdAt: 't0',
  updatedAt: 't0',
  archived: false,
})

const order = (id: string, issueId: string, minute: number): ShipOrder =>
  ({
    id: asShipOrderId(id),
    issueId: asIssueId(issueId),
    descendantManifest: [],
    repoId: REPO,
    repoPath: '/r',
    machineId: asMachineId('machine-1'),
    targetBranch: 'main',
    destination: 'local:main',
    approvedBaseSha: 'base',
    approvedHeadSha: `head-${id}`,
    deliveryDependsOn: [],
    requestedBy: {
      actor: { kind: 'user', id: firstAdminMemberId() },
      onBehalfOf: firstAdminMemberId(),
    },
    requestedAt: `2026-08-12T10:0${minute}:00.000Z`,
    policyId: 'default',
    validationProfile: PROFILE,
    validationProfileDigest: createHash('sha256').update(JSON.stringify(PROFILE)).digest('hex'),
    closeMode: 'after-destination',
    state: 'queued',
    stateChangedAt: '2026-08-12T10:00:00.000Z',
  }) as ShipOrder

const lane = (...orderIds: string[]): ShipLaneProjection => ({
  id: LANE.entityId,
  repoId: REPO,
  destination: 'local:main',
  trains: orderIds.map((id) => ({ orderIds: [asShipOrderId(id)] })),
  blockedOrderIds: [],
})

const principal = (user: string): Principal => ({
  kind: 'user',
  user: asUserId(user),
  device: asDeviceId(`device:${user}`),
  capability: asCapabilityRef(`cap:${user}`),
})

/** Two queued orders in one lane, both owned by `owner`; `reader` may read
 * only the issue of `order-shared`. */
async function fixture() {
  const store = await openTestStore(':memory:')
  stores.push(store)
  const world = await WorldIndex.load(store)
  await store.issues.upsertIssue(issueRow('iss_shared', 1))
  await store.issues.upsertIssue(issueRow('iss_private', 2))
  await store.shipping.createOrder(order('order-shared', 'iss_shared', 1))
  await store.shipping.createOrder(order('order-private', 'iss_private', 2))
  const grant = async (issueId: string, grantee: string) =>
    await store.grants.upsert({
      resourceKind: 'issue',
      resourceId: issueId,
      grantee,
      verb: 'read',
      owner,
      visibility: 'personal',
      createdAt: '2026-09-11T00:00:00Z',
      actorKind: 'user',
      actorId: owner,
      onBehalfOf: owner,
    })
  await grant('iss_shared', reader)
  const policy = makeFeedVisibility({
    store,
    worldIndex: world.reader,
    audienceResourceIds: (kind) => store.grants.visibilityAudienceResourceIds(kind),
    audienceFor: (kind, id) => store.grants.visibilityAudienceFor(kind, id),
    authorizationRevision: () => store.grants.visibilityRevision(),
  })
  const authority = new Authority({
    store: store.sync,
    now: () => 1_000,
    transact: async (fn) => await store.transact(fn),
    visibility: new GrantEdgeVisibilityPolicy(policy.state, new NoDelegationsGranted()),
    anchors: policy.anchors,
  })
  return { store, policy, authority, grant }
}

describe('POD-4974 O2 lane visibility', () => {
  it('lets anyone who may read one queued order read the lane, and no one else', async () => {
    const { policy, authority } = await fixture()
    for (const prepare of [policy.state.forBootstrap!, policy.state.forBatch!]) {
      const state = await prepare([LANE])
      expect(state.classOf('shipLane')).toBe('personal')
      expect(state.mayRead(owner, LANE)).toBe(true)
      expect(state.mayRead(reader, LANE)).toBe(true)
      expect(state.mayRead(stranger, LANE)).toBe(false)
    }
    const unknown: EntityRef = { entity: 'shipLane', entityId: 'not-a-lane' }
    expect((await policy.state.forBatch!([unknown])).mayRead(owner, unknown)).toBe(false)

    await authority.capture([
      {
        entity: 'shipLane',
        entityId: LANE.entityId,
        op: 'upsert',
        value: lane('order-shared', 'order-private'),
      },
    ])
    const lanesFor = async (user: string) =>
      (await authority.bootstrap(principal(user))).changes.filter(
        (change) => change.entity === 'shipLane',
      )
    expect(await lanesFor(reader)).toHaveLength(1)
    expect(await lanesFor(stranger)).toEqual([])
  })

  it('evicts the lane from the reader whose last readable order left it', async () => {
    const { store, policy, authority } = await fixture()
    await authority.capture([
      ...['order-shared', 'order-private'].map((id) => ({
        entity: 'shipOrder' as const,
        entityId: id,
        op: 'upsert' as const,
        value: { id, state: 'queued' },
      })),
      {
        entity: 'shipLane',
        entityId: LANE.entityId,
        op: 'upsert',
        value: lane('order-shared', 'order-private'),
      },
    ])
    // A queued order moves nobody's view of its lane.
    expect(
      await policy.anchors.visibilityEdge({ entity: 'shipOrder', entityId: 'order-shared' }),
    ).toBeNull()

    const cursor = await authority.cursor()
    await store.shipping.transitionOrder(
      'order-shared',
      'queued',
      'cancelled',
      '2026-08-12T11:00:00.000Z',
    )
    expect(
      await policy.anchors.visibilityEdge({ entity: 'shipOrder', entityId: 'order-shared' }),
    ).toEqual({
      audience: [reader],
      subjects: [LANE],
    })
    await authority.capture([
      { entity: 'shipOrder', entityId: 'order-shared', op: 'remove' },
      { entity: 'shipLane', entityId: LANE.entityId, op: 'upsert', value: lane('order-private') },
    ])
    const laneOps = async (user: string) => {
      const delta = await authority.changesSince(cursor, principal(user))
      if (delta?.kind !== 'batch') throw new Error('expected a delta batch')
      return delta.changes
        .filter((change) => change.entity === 'shipLane')
        .map((change) => change.op)
    }
    expect(await laneOps(reader)).toEqual(['evict'])
    expect(await laneOps(owner)).toEqual(['upsert'])
    expect(await laneOps(stranger)).toEqual([])
  })

  it('names the lanes of an issue queued orders when a grant moves its audience', async () => {
    const { policy, authority, grant } = await fixture()
    await authority.capture([
      {
        entity: 'shipOrder',
        entityId: 'order-private',
        op: 'upsert',
        value: {
          id: 'order-private',
          issueId: 'iss_private',
          repoId: REPO,
          targetBranch: 'main',
          destination: 'main',
          state: 'queued',
        },
      },
    ])
    await grant('iss_private', stranger)
    const edge = await policy.anchors.visibilityEdge({
      entity: 'issueProjection',
      entityId: 'iss_private',
    })
    expect(edge?.audience).toEqual([stranger])
    expect(edge?.subjects).toContainEqual(LANE)
  })
})
