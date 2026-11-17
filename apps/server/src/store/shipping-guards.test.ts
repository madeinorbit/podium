/**
 * THE SHIPPING TRAIN GUARDS REFUSE THE SAME ROWS WITH THE SAME TEXT ON BOTH ENGINES
 * (POD-6986, POD-6958 design 2.5).
 *
 * SQLite guards a train's rows in triggers: a member past the manifest's member count, a
 * member added after a claim, a final member that is not the leader, a claim without
 * complete leader authority, a claim released while its manifest is open, a release that
 * sets no time. Postgres has no triggers, so the repository's guarded writes carry each
 * rule in their own statement and raise the trigger's text when it refuses (`store/
 * append-only.ts`). The claim path never writes such a row; these cases drive the guarded
 * writes with them, on the run's engine, and expect the trigger's own words.
 *
 * The append-only tables and the frozen order, attempt and hold columns have no write
 * that could break them on Postgres: `immutability-census.test.ts` proves that of every
 * definition, and `store-issues.test.ts` proves SQLite's triggers with raw statements.
 */

import { createHash } from 'node:crypto'
import {
  asIssueId,
  asMachineId,
  asRepoId,
  asShipAttemptId,
  asShipOrderId,
  firstAdminMemberId,
  type ShipOrder,
  type ShipTrainManifest,
} from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  openShippingStoreSlice,
  type ShippingStoreSlice,
} from '../test-support/shipping-store-slice'
import { GUARD_TEXT } from './append-only'

const scope = fixtureWriteScope()
const AT = '2026-11-17T10:00:00.000Z'
const MACHINE = asMachineId('machine-1')
const REPO = asRepoId('repo-1')
const VALIDATION_PROFILE = {
  id: 'default',
  argv: ['bun', 'run', 'test'],
  cwd: 'integration-root' as const,
  timeoutMs: 60_000,
  resourceLocks: [] as string[],
}

type Member = ShipTrainManifest['members'][number]

/** The repository's guarded writes, which the claim path calls only with rows that keep the rules. */
interface GuardedWrites {
  recordTrainMember(trainId: string, ordinal: number, member: Member): Promise<void>
  recordActiveClaim(
    trainId: string,
    member: Pick<Member, 'orderId' | 'attemptId' | 'generation'>,
  ): Promise<void>
  releaseActiveClaims(trainId: string): Promise<number>
}

/** The message at the bottom of a refusal: the trigger's on SQLite, the guard's on Postgres. */
async function refusal(write: Promise<unknown>): Promise<string> {
  try {
    await write
  } catch (error) {
    let cause = error as { message?: string; cause?: unknown }
    while (cause.cause !== undefined && cause.cause !== null) {
      cause = cause.cause as { message?: string; cause?: unknown }
    }
    return String(cause.message)
  }
  throw new Error('the write was not refused')
}

const order = (name: string, overrides: Partial<ShipOrder> = {}): ShipOrder =>
  ({
    id: asShipOrderId(`order-${name}`),
    issueId: asIssueId(`iss-${name}`),
    descendantManifest: [],
    repoId: REPO,
    repoPath: '/r',
    machineId: MACHINE,
    targetBranch: 'main',
    destination: 'origin/main',
    approvedBaseSha: 'base',
    approvedHeadSha: `${name}-head`,
    deliveryDependsOn: [],
    requestedBy: {
      actor: { kind: 'user', id: firstAdminMemberId() },
      onBehalfOf: firstAdminMemberId(),
    },
    requestedAt: '2026-11-17T09:00:00.000Z',
    policyId: 'default',
    validationProfile: VALIDATION_PROFILE,
    validationProfileDigest: createHash('sha256')
      .update(JSON.stringify(VALIDATION_PROFILE))
      .digest('hex'),
    closeMode: 'after-destination',
    state: 'queued',
    stateChangedAt: '2026-11-17T09:00:00.000Z',
    ...overrides,
  }) as ShipOrder

let s: ShippingStoreSlice
let guarded: GuardedWrites
/** A claimed two-member train: its manifest is open and both members hold claims. */
let claimed: ShipTrainManifest
/** A manifest of one member with no member recorded and no claim, led by `single`. */
const unclaimedTrain = 'train:unclaimed'
const single = {
  orderId: asShipOrderId('order-single'),
  attemptId: asShipAttemptId('attempt-single'),
}

beforeEach(async () => {
  s = await openShippingStoreSlice()
  guarded = s.shipping as unknown as GuardedWrites
  for (const [seq, name] of ['lower', 'covering', 'single'].entries()) {
    await s.run(
      sql`INSERT INTO issues (workspace_id, id, owner_user_id, created_by_actor, repo_path, repo_id,
           machine_id, branch, seq, title, stage, default_agent, created_at, updated_at)
         VALUES ('local', ${`iss-${name}`}, ${firstAdminMemberId()}, ${firstAdminMemberId()}, '/r',
           ${REPO}, ${MACHINE}, ${`issue/${name}`}, ${seq + 1}, ${name}, 'review', 'codex', ${AT}, ${AT})`,
    )
  }
  const lower = order('lower')
  const covering = order('covering', { deliveryDependsOn: [lower.id] })
  await s.shipping.createOrder(scope, lower)
  await s.shipping.createOrder(scope, covering)
  claimed = (
    await s.shipping.claimTrain(scope, {
      leaderOrderId: covering.id,
      startedAt: '2026-11-17T09:05:00.000Z',
      members: [{ orderId: lower.id }, { orderId: covering.id }],
    })
  ).manifest
  // Its own lane: an order enqueued on the claimed train's lane would release that train.
  await s.shipping.createOrder(scope, order('single', { targetBranch: 'release' }))
  await s.shipping.createAttempt(scope, {
    id: single.attemptId,
    orderId: single.orderId,
    expectedSourceBaseSha: 'base',
    approvedHeadSha: 'single-head',
    expectedTargetSha: 'target',
    machineId: MACHINE,
    leaseGeneration: 1,
    startedAt: AT,
    submittedHeadSha: 'single-head',
  })
  await s.run(
    sql`INSERT INTO ship_train_manifests (workspace_id, id, version, subset_id, repair_round,
         canonical_digest, canonical_json, repo_id, repo_path, machine_id, lane_key, lane_revision,
         target_branch, expected_target_sha, destination, policy_id, validation_profile,
         validation_profile_digest, member_count, leader_order_id, leader_attempt_id,
         leader_generation, created_at)
       VALUES ('local', ${unclaimedTrain}, 1, 'subset:unclaimed', 0, 'digest-unclaimed', '{}',
         ${REPO}, '/r', ${MACHINE}, 'lane-unclaimed', 1, 'main', 'target', 'origin/main',
         'default', '{}', 'profile-digest', 1, ${single.orderId}, ${single.attemptId}, 1, ${AT})`,
  )
})

afterEach(async () => {
  await s.close()
})

/** The single order's member row at ordinal 0, with `generation`. */
const singleMember = (generation: number): Member => ({
  ...claimed.members[0]!,
  issueId: asIssueId('iss-single'),
  orderId: single.orderId,
  attemptId: single.attemptId,
  generation,
  sourceBranch: 'issue/single',
  approvedHeadSha: 'single-head',
  deliveryDependsOn: [],
})

describe('the train guards (design 2.5)', () => {
  it('refuses a member past the manifest member count', async () => {
    const member = claimed.members[0]!
    expect(await refusal(guarded.recordTrainMember(claimed.id, claimed.memberCount, member))).toBe(
      GUARD_TEXT.ship_train_members_ordinal,
    )
  })

  it('refuses a member once the train holds an active claim', async () => {
    expect(await refusal(guarded.recordTrainMember(claimed.id, 0, claimed.members[0]!))).toBe(
      GUARD_TEXT.ship_train_members_sealed,
    )
  })

  it('refuses a final member that is not the manifest leader, and records the leader', async () => {
    expect(await refusal(guarded.recordTrainMember(unclaimedTrain, 0, singleMember(2)))).toBe(
      GUARD_TEXT.ship_train_members_final_leader,
    )
    await guarded.recordTrainMember(unclaimedTrain, 0, singleMember(1))
    const members = await s.all<{ ordinal: number }>(
      sql`SELECT ordinal FROM ship_train_members WHERE train_id = ${unclaimedTrain}`,
    )
    expect(members.map((row) => Number(row.ordinal))).toEqual([0])
  })

  it('refuses a claim without complete leader authority, and accepts it once the members are recorded', async () => {
    const claim = { orderId: single.orderId, attemptId: single.attemptId, generation: 1 }
    expect(await refusal(guarded.recordActiveClaim(unclaimedTrain, claim))).toBe(
      GUARD_TEXT.ship_train_active_claims_insert_guard,
    )
    await guarded.recordTrainMember(unclaimedTrain, 0, singleMember(1))
    await guarded.recordActiveClaim(unclaimedTrain, claim)
    const claims = await s.all<{ orderId: string }>(
      sql`SELECT order_id AS "orderId" FROM ship_train_active_claims WHERE train_id = ${unclaimedTrain}`,
    )
    expect(claims).toEqual([{ orderId: single.orderId }])
  })

  it('refuses to release claims while the manifest is open, and releases them with it', async () => {
    expect(await refusal(guarded.releaseActiveClaims(claimed.id))).toBe(
      GUARD_TEXT.ship_train_active_claims_release_guard,
    )
    await s.shipping.releaseTrain(scope, claimed.id, AT, 'test release')
    const claims = await s.all<{ orderId: string }>(
      sql`SELECT order_id AS "orderId" FROM ship_train_active_claims WHERE train_id = ${claimed.id}`,
    )
    expect(claims).toEqual([])
  })

  it('refuses a release that sets no release time', async () => {
    expect(
      await refusal(s.shipping.releaseTrain(scope, claimed.id, null as never, 'no time')),
    ).toBe(GUARD_TEXT.ship_train_manifests_release_only)
  })
})
