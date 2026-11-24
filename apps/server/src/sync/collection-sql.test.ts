/**
 * COLLECTION RULES READ THE VALUE THE RECORD CARRIES (POD-7084).
 *
 * Sessions and issues are written through the store's own write paths,
 * including the satellites that change what a session record carries: an
 * observation checkpoint and a runtime turn state over the row's agent state,
 * and an offer made stale by a later input. Their records are built by the
 * real record builders. Then every declared rule over sessions and issues
 * must answer in SQL (`collection-sql.ts`, on this SQLite schema) exactly
 * what it answers in JavaScript over the built records. "Asking" is pinned on top: a checkpoint turns it on and
 * off against the row's own agent state.
 */

import {
  type AgentRuntimeState,
  actorUser,
  asMachineId,
  asSessionId,
  declaredRules,
  firstAdminMemberId,
  type IssueId,
  matchesWhere,
  type RuleArgs,
  type SessionId,
} from '@podium/model'
import { collectRecords } from '@podium/sync/record-builders'
import { fixtureWriteScope } from '@podium/sync/testing'
import { getTableName, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sessions } from '../migrations/schema'
import type { SessionStore } from '../store'
import type { SessionRow } from '../store/types'
import { ruleDialectOfStore, runCollectionStatement } from '../test-support/collection-statement'
import { issueRowFixture } from '../test-support/issue-row'
import { openTestStore } from '../test-support/open-test-store'
import { storeSql } from '../test-support/store-sql'
import { type CollectionKind, collectionFields, collectionQuery } from './collection-sql'
import { type RecordReads, serverRecordBuilders } from './record-builders'

const NOW = Date.parse('2026-11-17T12:00:00.000Z')
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString()
const state = (
  phase: AgentRuntimeState['phase'],
  idle?: 'done' | 'question',
): AgentRuntimeState => ({
  phase,
  since: ago(1),
  nativeSubagentCount: 0,
  ...(idle ? { idle: { kind: idle } } : {}),
})

interface Planted {
  readonly id: string
  readonly row?: Partial<SessionRow>
  readonly offerAt?: string
  readonly checkpoint?: AgentRuntimeState
  readonly runtime?: AgentRuntimeState
}

/** What each session's row says, and what its satellites say over it. */
const PLANTED: readonly Planted[] = [
  { id: 's-row-asks', row: { agentState: state('needs_user'), issueId: 'iss_a' as IssueId } },
  // The checkpoint overrides the row: it asks, the row does not.
  {
    id: 's-checkpoint-asks',
    row: { agentState: state('working') },
    checkpoint: state('needs_user'),
  },
  // The checkpoint overrides the row: the row asks, it does not.
  {
    id: 's-checkpoint-done',
    row: { agentState: state('needs_user') },
    checkpoint: state('idle', 'done'),
  },
  // The runtime turn state overrides both.
  {
    id: 's-runtime-working',
    row: { agentState: state('needs_user') },
    checkpoint: state('errored'),
    runtime: state('working'),
  },
  { id: 's-idle-question', row: { agentState: state('idle', 'question'), status: 'starting' } },
  { id: 's-offer', row: { lastInputAt: ago(3), issueId: 'iss_a' as IssueId }, offerAt: ago(2) },
  // A later input makes the offer stale: the record carries none.
  { id: 's-stale-offer', row: { lastInputAt: ago(1) }, offerAt: ago(2) },
  {
    id: 's-archived',
    row: { agentState: state('needs_user'), archived: true, issueId: 'iss_a' as IssueId },
  },
  {
    id: 's-deleted',
    row: { agentState: state('needs_user'), deletedAt: ago(1), deletionSource: 'standalone' },
  },
  {
    id: 's-headless',
    row: { headless: true, issueId: 'iss_a' as IssueId, status: 'exited', lastActiveAt: ago(40) },
  },
  {
    id: 's-shell',
    row: { agentKind: 'shell', issueId: 'iss_b' as IssueId, refIssueId: 'iss_a' as IssueId },
  },
]

/** Issue rows: a tree with a grandchild, a closed one, a proposed one, a deleted one. */
const ISSUES = [
  { id: 'iss_a', seq: 1, parentId: null, stage: 'in_progress', updatedAt: ago(1) },
  {
    id: 'iss_b',
    seq: 2,
    parentId: 'iss_a',
    stage: 'done',
    closedReason: 'done',
    updatedAt: ago(20),
  },
  {
    id: 'iss_c',
    seq: 3,
    parentId: 'iss_b',
    stage: 'backlog',
    startedBySession: 's-offer',
    updatedAt: ago(8),
  },
  {
    id: 'iss_d',
    seq: 4,
    parentId: null,
    stage: 'proposed',
    supersededBy: 'iss_a',
    updatedAt: ago(2),
  },
  {
    id: 'iss_e',
    seq: 5,
    parentId: null,
    stage: 'review',
    archived: true,
    duplicateOf: 'iss_b',
    updatedAt: ago(3),
  },
] as const

/** Arguments every declared rule over these types can be answered with. */
const ARGS: readonly RuleArgs[] = [
  {
    recentDays: 7,
    issueId: 'iss_a',
    sessionId: 's-offer',
    id: 's-offer',
    root: 'iss_a',
    stage: 'in_progress',
    priority: 2,
  },
  {
    recentDays: 30,
    issueId: 'iss_b',
    sessionId: 's-shell',
    id: 'iss_c',
    root: 'iss_b',
    stage: 'proposed',
    priority: 1,
  },
]

function sessionRow(
  planted: Planted,
  owner: SessionRow['ownerUserId'],
  machineId: SessionRow['machineId'],
): SessionRow {
  return {
    id: asSessionId(planted.id),
    ownerUserId: owner,
    agentKind: 'codex',
    cwd: '/workspace',
    title: planted.id,
    name: null,
    nameSource: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: null,
    resumeValue: null,
    status: 'live',
    exitCode: null,
    spawnFailure: null,
    durableLabel: `podium-${planted.id}`,
    createdAt: ago(50),
    lastActiveAt: ago(1),
    geometry: { cols: 120, rows: 40 },
    archived: false,
    workState: null,
    machineId,
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
    spawnedBy: 'user',
    headless: false,
    issueId: null,
    refIssueId: null,
    refLetter: null,
    refDraft: null,
    stoppedAt: null,
    stopReason: null,
    workflowRunId: null,
    workflowStepId: null,
    agentProfileId: null,
    deletedAt: null,
    deletionSource: null,
    deletedByIssueId: null,
    createdBy: { actor: actorUser(owner!), onBehalfOf: owner! },
    ...planted.row,
  }
}

async function plant(store: SessionStore): Promise<void> {
  const owner = await firstAdminMemberId(store)
  for (const issue of ISSUES) {
    await store.issues.upsertIssue(
      fixtureWriteScope(),
      issueRowFixture({ archived: false, closedReason: null, ...issue }),
    )
  }
  for (const planted of PLANTED) {
    const id = asSessionId(planted.id)
    await store.sessions.upsertSession(
      fixtureWriteScope(),
      sessionRow(planted, owner, asMachineId(store.hostMachine!.id)),
    )
    if (planted.offerAt) {
      await store.sessions.setOffer(fixtureWriteScope(), id, {
        message: 'Ready',
        actions: [],
        createdAt: planted.offerAt,
      })
    }
    if (planted.checkpoint) {
      await store.observationCheckpoints.advanceGeneration(id, 'codex', `thread-${planted.id}`)
      await store.observationCheckpoints.save({
        schemaVersion: 1,
        podiumSessionId: id,
        provider: 'codex',
        providerSessionId: `thread-${planted.id}`,
        bindingVersion: 1,
        lifecycleObservationGeneration: 1,
        providerCursor: { segmentId: 'rollout-1', components: { file: 42 } },
        bootstrapCursor: { segmentId: 'rollout-1', components: { file: 42 } },
        lastAcceptedLiveCursor: null,
        turnEpoch: 0,
        providerTurnId: null,
        providerPromptId: null,
        turnState: planted.checkpoint,
        terminalFence: null,
        providerAt: ago(1),
        acceptedAt: ago(1),
        lastLiveReceiptAt: null,
        lastTransitionId: 'snapshot-1',
      })
    }
    if (planted.runtime) {
      await store.events.saveRuntimeEventCheckpoint({
        sessionId: id,
        observerGeneration: 1,
        cursor: { segmentId: 'rollout-1', components: { file: 42 } },
        turnEpoch: 1,
        closedTurnEpoch: null,
        updatedAt: ago(1),
        turnState: planted.runtime,
      })
    }
  }
}

const KINDS: readonly CollectionKind[] = ['session', 'issueProjection']

describe('collection rules over the server tables', () => {
  let store: SessionStore
  const built = new Map<CollectionKind, Readonly<Record<string, unknown>>[]>()

  beforeAll(async () => {
    store = await openTestStore(':memory:')
    await plant(store)
    const reads = {
      store,
      effectExecutors: { get: () => undefined },
      now: () => NOW,
    } as unknown as RecordReads
    for (const kind of KINDS) {
      const records = await collectRecords(serverRecordBuilders().streamAll(reads, kind))
      built.set(
        kind,
        records.map(({ value }) => value as Record<string, unknown>),
      )
    }
  })

  afterAll(async () => {
    await store?.close()
  })

  const keyOf = (kind: CollectionKind, value: Readonly<Record<string, unknown>>) =>
    String(kind === 'session' ? value['sessionId'] : value['id'])

  function jsAnswer(
    kind: CollectionKind,
    where: Parameters<typeof matchesWhere>[0],
    args: RuleArgs,
  ): string[] {
    const values = built.get(kind)!
    const parents = new Map(
      values.map((v) => [keyOf(kind, v), v['parentId'] as string | undefined]),
    )
    return values
      .filter((value) =>
        matchesWhere(where, value, {
          now: NOW,
          args,
          parentOf: (id) => parents.get(id),
          idOf: (v) => keyOf(kind, v),
        }),
      )
      .map((value) => keyOf(kind, value))
      .sort()
  }

  // On the run's engine, in its dialect (POD-7118).
  async function sqlAnswer(
    kind: CollectionKind,
    where: Parameters<typeof matchesWhere>[0],
    args: RuleArgs,
  ): Promise<string[]> {
    const query = collectionQuery(kind, where, args, NOW, ruleDialectOfStore(store))
    return (await runCollectionStatement<{ id: string }>(store, query)).map((r) => r.id).sort()
  }

  it('builds the planted records, without the deleted session', () => {
    expect(
      built
        .get('session')!
        .map((v) => keyOf('session', v))
        .sort(),
    ).toEqual(
      PLANTED.filter((p) => p.id !== 's-deleted')
        .map((p) => p.id)
        .sort(),
    )
    expect(built.get('issueProjection')!.length).toBe(ISSUES.length)
  })

  it('maps every field a declared rule reads', () => {
    for (const rule of declaredRules()) {
      if (!(KINDS as readonly string[]).includes(rule.of)) continue
      expect(
        () => collectionQuery(rule.of as CollectionKind, rule.where, ARGS[0]!, NOW),
        rule.id,
      ).not.toThrow()
    }
    expect(collectionFields('session')).toContain('agentState')
  })

  for (const rule of declaredRules().filter((r) => (KINDS as readonly string[]).includes(r.of))) {
    for (const [at, args] of ARGS.entries()) {
      it(`${rule.id} (arguments ${at + 1}) answers as its records do`, async () => {
        const kind = rule.of as CollectionKind
        expect(await sqlAnswer(kind, rule.where, args)).toEqual(jsAnswer(kind, rule.where, args))
      })
    }
  }

  it('reads asking from the checkpoint and the runtime state over the row, and drops a stale offer', async () => {
    const asking = declaredRules().find((rule) => rule.id === 'session.asking')!
    const want = ['s-checkpoint-asks', 's-idle-question', 's-offer', 's-row-asks']
    expect(jsAnswer('session', asking.where, {})).toEqual(want)
    expect(await sqlAnswer('session', asking.where, {})).toEqual(want)
  })

  it('would answer differently if it read the row alone', async () => {
    // The row's own agent state says the opposite for the three overridden sessions.
    const raw = storeSql(store)
    const phase =
      raw.engine === 'pg'
        ? sql`(${sql.identifier(sessions.agentStateJson.name)} ->> 'phase')`
        : sql`json_extract(${sql.identifier(sessions.agentStateJson.name)}, '$.phase')`
    const notArchived =
      raw.engine === 'pg'
        ? sql`NOT ${sql.identifier(sessions.archived.name)}`
        : sql`${sql.identifier(sessions.archived.name)} = 0`
    const rowOnly = await raw.all<{ id: SessionId }>(
      sql`SELECT ${sql.identifier(sessions.id.name)} AS id FROM ${sql.identifier(getTableName(sessions))} WHERE ${phase} = 'needs_user' AND ${sql.identifier(sessions.deletedAt.name)} IS NULL AND ${notArchived}`,
    )
    expect(rowOnly.map((r) => r.id).sort()).toEqual([
      's-checkpoint-done',
      's-row-asks',
      's-runtime-working',
    ])
  })
})
