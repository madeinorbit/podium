/**
 * Feed scoping runs a fixed number of statements, whatever the batch size
 * [POD-6149, server-data rule 8]: the prefetch for a change batch reads each
 * table once, and a lane departure reads its member issues together. Grant
 * edges come from the grants table (POD-6155): one grouped read per resource
 * kind for a batch, one for a lane's members, never one per subject.
 */

import { createHash } from 'node:crypto'
import {
  asIssueId,
  asMachineId,
  asRepoId,
  asShipOrderId,
  asUserId,
  firstAdminMemberId,
  type ShipOrder,
  shipLaneId,
} from '@podium/model'
import type { EntityRef } from '@podium/sync'
import { describe, expect, it } from 'vitest'
import { makeFeedVisibility } from './feed-visibility'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'
import { expectConstantStatements, type StatementPin } from './test-support/statement-count'

const owner = asUserId('owner')
const reader = asUserId('reader')

const PROFILE = {
  id: 'default',
  argv: ['bun', 'run', 'test'],
  cwd: 'integration-root' as const,
  timeoutMs: 60_000,
  resourceLocks: [] as string[],
}

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
  acceptance: null,
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

const order = (id: string, issueId: string, repo: string): ShipOrder =>
  ({
    id: asShipOrderId(id),
    issueId: asIssueId(issueId),
    descendantManifest: [],
    repoId: asRepoId(repo),
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
    requestedAt: '2026-08-12T10:00:00.000Z',
    policyId: 'default',
    validationProfile: PROFILE,
    validationProfileDigest: createHash('sha256').update(JSON.stringify(PROFILE)).digest('hex'),
    closeMode: 'after-destination',
    state: 'queued',
    stateChangedAt: '2026-08-12T10:00:00.000Z',
  }) as ShipOrder

interface Fixture {
  store: SessionStore
  policy: ReturnType<typeof makeFeedVisibility>
  size: number
}

/**
 * `size` issues, each with one queued order in its own lane (`repo-i`), plus
 * `size` orders queued in ONE shared lane (`repo-shared`) whose first issue is
 * shared with the reader.
 */
async function fixture(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  for (let i = 0; i < size; i++) {
    await store.issues.upsertIssue(issueRow(`iss_${i}`, i + 1))
    await store.shipping.createOrder(order(`order-${i}`, `iss_${i}`, `repo-${i}`))
    await store.issues.upsertIssue(issueRow(`shared_${i}`, size + i + 1))
    await store.shipping.createOrder(order(`shared-order-${i}`, `shared_${i}`, 'repo-shared'))
  }
  await store.grants.upsert({
    resourceKind: 'issue',
    resourceId: 'shared_0',
    grantee: reader,
    verb: 'read',
    owner,
    visibility: 'personal',
    createdAt: '2026-09-11T00:00:00Z',
    actorKind: 'user',
    actorId: owner,
    onBehalfOf: owner,
  })
  const policy = makeFeedVisibility({
    store,
    audienceResourceIds: (kind) => store.grants.visibilityAudienceResourceIds(kind),
    audienceFor: (kind, id) => store.grants.visibilityAudienceFor(kind, id),
    authorizationRevision: () => store.grants.visibilityRevision(),
  })
  return { store, policy, size }
}

/** A change batch naming `size` rows of every kind the prefetch resolves,
 * plus the one issue shared with the reader. */
const batchRefs = (size: number): EntityRef[] => [
  { entity: 'issueProjection', entityId: 'shared_0' },
  ...Array.from({ length: size }, (_, i): EntityRef[] => [
    { entity: 'issueProjection', entityId: `iss_${i}` },
    { entity: 'shipOrder', entityId: `order-${i}` },
    { entity: 'shipLane', entityId: shipLaneId(asRepoId(`repo-${i}`), 'local:main') },
    { entity: 'session', entityId: `session-${i}` },
    { entity: 'conversation', entityId: `resume-${i}` },
    { entity: 'automation', entityId: `automation-${i}` },
    { entity: 'automationRun', entityId: `run-${i}` },
  ]).flat(),
]

const pin = (
  name: string,
  run: (f: Fixture) => Promise<unknown>,
  check: (result: unknown, f: Fixture) => void,
): StatementPin<Fixture> => ({
  name,
  setup: fixture,
  target: (f) => f.store,
  run,
  check: (result, f) => check(result, f),
  teardown: async (f) => await f.store.close(),
})

describe('feed scoping: pinned statement counts at 5 and 200 rows per kind', () => {
  it('a change batch prefetch reads each table once', async () => {
    await expectConstantStatements(
      pin(
        'visibility forBatch',
        async (f) => await f.policy.state.forBatch!(batchRefs(f.size)),
        (state, f) => {
          const s = state as Awaited<ReturnType<NonNullable<typeof f.policy.state.forBatch>>>
          const lane: EntityRef = {
            entity: 'shipLane',
            entityId: shipLaneId(asRepoId(`repo-${f.size - 1}`), 'local:main'),
          }
          expect(s.mayRead(owner, lane)).toBe(true)
          expect(s.mayRead(reader, lane)).toBe(false)
          expect(s.mayRead(owner, { entity: 'automation', entityId: 'automation-0' })).toBe(false)
          // The grant edge decides: shared with the reader, and nothing else is.
          expect(s.mayRead(reader, { entity: 'issueProjection', entityId: 'shared_0' })).toBe(true)
          expect(s.mayRead(reader, { entity: 'issueProjection', entityId: 'iss_0' })).toBe(false)
        },
      ),
      // 7 table reads, plus the issue grants and the session grants.
      9,
    )
  })

  it('a lane departure reads the lane members together', async () => {
    await expectConstantStatements(
      {
        ...pin(
          'laneDepartureEdge',
          async (f) => await f.policy.anchors.visibilityEdge({ entity: 'shipOrder', entityId: 'shared-order-0' }),
          // The reader could read only the departed order's issue.
          (edge) =>
            expect(edge).toEqual({
              audience: [reader],
              subjects: [{ entity: 'shipLane', entityId: shipLaneId(asRepoId('repo-shared'), 'local:main') }],
            }),
        ),
        setup: async (size) => {
          const f = await fixture(size)
          await f.store.shipping.transitionOrder(
            'shared-order-0',
            'queued',
            'cancelled',
            '2026-08-12T11:00:00.000Z',
          )
          return f
        },
      },
      // 5 reads, plus the member issues' grants.
      6,
    )
  })
})
