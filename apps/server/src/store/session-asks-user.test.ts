/**
 * `sessions.asks_user` FOLLOWS EVERY WRITE OF WHAT IT IS DERIVED FROM (POD-7104).
 *
 * The column says whether a session waits for the user, as the "asking" rule
 * reads the record its builder makes: an offer no later input made stale, or
 * an agent state (runtime turn state over observation checkpoint over the
 * row) that needs the user, errored, or idles on a question or an approval;
 * never for an archived or deleted session. The migration's triggers write
 * it. Here each input is written through the store's own write paths, and
 * after every write the column must equal the JavaScript rule over the
 * session's built record, the answer key. The migration's backfill is held to
 * the same rule over rows written before it.
 */

import {
  type AgentRuntimeState,
  ASKING_WHERE,
  actorUser,
  asIssueId,
  asMachineId,
  asSessionId,
  firstAdminMemberId,
  matchesWhere,
  type SessionId,
} from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { collectRecords } from '@podium/sync/record-builders'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runDrizzleMigrations } from '../migrations'
import { DRIZZLE_MIGRATIONS } from '../migrations/drizzle-manifest.generated'
import type { SessionStore } from '../store'
import { ASKS_USER_CLAUSES } from '../sync/collection-sql'
import { type RecordReads, serverRecordBuilders } from '../sync/record-builders'
import { issueRowFixture } from '../test-support/issue-row'
import { openTestStore } from '../test-support/open-test-store'
import type { SessionRow } from './types'

const NOW = Date.parse('2026-11-17T12:00:00.000Z')
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()

const state = (
  phase: AgentRuntimeState['phase'],
  idle?: 'done' | 'question' | 'approval' | 'open_todos' | 'interrupted',
): AgentRuntimeState => ({
  phase,
  since: at(-60),
  nativeSubagentCount: 0,
  ...(idle ? { idle: { kind: idle } } : {}),
})

type RawDb = { prepare(sql: string): { get(...params: unknown[]): unknown } }

describe('sessions.asks_user follows every writer of its inputs', () => {
  let store: SessionStore
  let owner: SessionRow['ownerUserId']
  const rows = new Map<string, SessionRow>()
  let checkpointGeneration = 0

  beforeAll(async () => {
    store = await openTestStore(':memory:')
    owner = await firstAdminMemberId(store)
    await store.issues.upsertIssue(
      fixtureWriteScope(),
      issueRowFixture({
        id: 'iss_asks',
        seq: 1,
        parentId: null,
        archived: false,
        closedReason: null,
      }),
    )
  })

  afterAll(async () => {
    await store?.close()
  })

  function row(id: string, over: Partial<SessionRow> = {}): SessionRow {
    return {
      id: asSessionId(id),
      ownerUserId: owner,
      agentKind: 'codex',
      cwd: '/workspace',
      title: id,
      name: null,
      nameSource: null,
      originKind: 'spawn',
      conversationId: null,
      resumeKind: null,
      resumeValue: null,
      status: 'live',
      exitCode: null,
      spawnFailure: null,
      durableLabel: `podium-${id}`,
      createdAt: at(-600),
      lastActiveAt: at(-1),
      geometry: { cols: 120, rows: 40 },
      archived: false,
      workState: null,
      machineId: asMachineId(store.hostMachineId),
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
      ...over,
    }
  }

  /** Write the session's row through the one-row upsert, changing `over`. */
  async function upsert(id: string, over: Partial<SessionRow> = {}): Promise<void> {
    const next = { ...(rows.get(id) ?? row(id)), ...over }
    rows.set(id, next)
    await store.sessions.upsertSession(fixtureWriteScope(), next)
  }

  const column = (id: string): number | undefined =>
    (
      (store as unknown as { db: RawDb }).db
        .prepare('SELECT asks_user FROM sessions WHERE id = ?')
        .get(id) as { asks_user: number } | undefined
    )?.asks_user

  /** The rule over the session's record as the builder makes it; no record, no ask. */
  async function rule(id: string): Promise<boolean> {
    const reads = {
      store,
      effectExecutors: { get: () => undefined },
      now: () => NOW,
    } as unknown as RecordReads
    const records = await collectRecords(serverRecordBuilders().streamAll(reads, 'session'))
    const record = records
      .map(({ value }) => value as Record<string, unknown>)
      .find((value) => value['sessionId'] === id)
    return record !== undefined && matchesWhere(ASKING_WHERE, record, { now: NOW, args: {} })
  }

  /** The column holds what the rule says, and the rule says `asks`. */
  async function follows(id: string, asks: boolean): Promise<void> {
    expect(await rule(id), `the rule for ${id}`).toBe(asks)
    expect(column(id), `asks_user of ${id}`).toBe(asks ? 1 : 0)
  }

  async function checkpoint(id: string, turnState: AgentRuntimeState): Promise<void> {
    const sessionId = asSessionId(id)
    const lease = await store.observationCheckpoints.get(sessionId)
    if (lease === null) {
      await store.observationCheckpoints.advanceGeneration(sessionId, 'codex', `thread-${id}`)
      checkpointGeneration = 1
    }
    await store.observationCheckpoints.save({
      schemaVersion: 1,
      podiumSessionId: sessionId,
      provider: 'codex',
      providerSessionId: `thread-${id}`,
      bindingVersion: 1,
      lifecycleObservationGeneration: checkpointGeneration,
      providerCursor: { segmentId: 'rollout-1', components: { file: 42 } },
      bootstrapCursor: { segmentId: 'rollout-1', components: { file: 42 } },
      lastAcceptedLiveCursor: null,
      turnEpoch: 0,
      providerTurnId: null,
      providerPromptId: null,
      turnState,
      terminalFence: null,
      providerAt: at(-1),
      acceptedAt: at(-1),
      lastLiveReceiptAt: null,
      lastTransitionId: `snapshot-${id}`,
    })
  }

  async function runtime(id: string, turnState: AgentRuntimeState | undefined): Promise<void> {
    await store.events.saveRuntimeEventCheckpoint({
      sessionId: asSessionId(id),
      observerGeneration: 1,
      cursor: { segmentId: 'rollout-1', components: { file: 42 } },
      turnEpoch: 1,
      closedTurnEpoch: null,
      updatedAt: at(-1),
      ...(turnState ? { turnState } : {}),
    })
  }

  it('is frozen to the declared rule', () => {
    expect(ASKS_USER_CLAUSES).toEqual(ASKING_WHERE)
  })

  it('follows the offer: set, made stale by a later input, renewed, cleared', async () => {
    const id = 's-offer'
    await upsert(id, { agentState: state('working') })
    await follows(id, false)
    await store.sessions.setOffer(fixtureWriteScope(), asSessionId(id), {
      message: 'Ready',
      actions: [],
      createdAt: at(-30),
    })
    await follows(id, true)
    // A later input makes the offer stale.
    await upsert(id, { lastInputAt: at(-10) })
    await follows(id, false)
    // An input before the offer does not.
    await upsert(id, { lastInputAt: at(-40) })
    await follows(id, true)
    await upsert(id, { lastInputAt: at(-10) })
    await follows(id, false)
    // A newer offer is open again.
    await store.sessions.setOffer(fixtureWriteScope(), asSessionId(id), {
      message: 'Ready again',
      actions: [],
      createdAt: at(-5),
    })
    await follows(id, true)
    await store.sessions.clearOffer(fixtureWriteScope(), asSessionId(id))
    await follows(id, false)
  })

  it('follows each agent phase of the row', async () => {
    const id = 's-phases'
    const cases: readonly [AgentRuntimeState | undefined, boolean][] = [
      [undefined, false],
      [state('unknown'), false],
      [state('working'), false],
      [state('needs_user'), true],
      [state('compacting'), false],
      [state('errored'), true],
      [state('idle', 'done'), false],
      [state('idle', 'question'), true],
      [state('idle', 'open_todos'), false],
      [state('idle', 'approval'), true],
      [state('idle', 'interrupted'), false],
      [state('idle'), false],
      [state('ended'), false],
      [state('needs_user'), true],
    ]
    for (const [agentState, asks] of cases) {
      await upsert(id, { agentState })
      await follows(id, asks)
    }
  })

  it('follows the observation checkpoint over the row, and the row again once it is cleared', async () => {
    const id = 's-checkpoint'
    await upsert(id, { agentState: state('needs_user') })
    await follows(id, true)
    await checkpoint(id, state('working'))
    await follows(id, false)
    await checkpoint(id, state('idle', 'question'))
    await follows(id, true)
    // The checkpoint keeps overriding a row that changes under it.
    await upsert(id, { agentState: state('working') })
    await follows(id, true)
    await checkpoint(id, state('idle', 'done'))
    await follows(id, false)
    await upsert(id, { agentState: state('errored') })
    await follows(id, false)
    // Deleting the lease: the row answers again.
    await store.observationCheckpoints.purge(asSessionId(id))
    await follows(id, true)
    await checkpoint(id, state('working'))
    await follows(id, false)
    // A rebind drops the checkpoint's state: the row answers again.
    const rebound = await store.observationCheckpoints.rebindExact({
      sessionId: asSessionId(id),
      provider: 'codex',
      providerSessionId: `thread-${id}`,
      bindingVersion: 1,
      observationGeneration: checkpointGeneration,
      nextProviderSessionId: `thread-${id}-next`,
    })
    expect(rebound).toMatchObject({ kind: 'accepted' })
    await follows(id, true)
  })

  it('follows the runtime turn state over the checkpoint and the row', async () => {
    const id = 's-runtime'
    await upsert(id, { agentState: state('needs_user') })
    await checkpoint(id, state('errored'))
    await follows(id, true)
    await runtime(id, state('working'))
    await follows(id, false)
    await runtime(id, state('idle', 'approval'))
    await follows(id, true)
    await upsert(id, { agentState: state('working') })
    await checkpoint(id, state('working'))
    await follows(id, true)
    await runtime(id, state('idle', 'done'))
    await follows(id, false)
    // No runtime turn state: the checkpoint answers again.
    await checkpoint(id, state('needs_user'))
    await runtime(id, undefined)
    await follows(id, true)
  })

  it('leaves out archived and deleted sessions, and takes a restored one back', async () => {
    const id = 's-archive'
    await upsert(id, { agentState: state('needs_user'), issueId: asIssueId('iss_asks') })
    await follows(id, true)
    await upsert(id, { archived: true })
    await follows(id, false)
    await upsert(id, { archived: false })
    await follows(id, true)
    await store.sessions.softDeleteForIssue(fixtureWriteScope(), [id], asIssueId('iss_asks'), at(0))
    await follows(id, false)
    await store.sessions.restoreDeletedForIssue(fixtureWriteScope(), asIssueId('iss_asks'))
    await follows(id, true)
    await store.sessions.softDeleteSessions(fixtureWriteScope(), [id], at(1), 'standalone')
    await follows(id, false)
    await store.sessions.purgeSession(fixtureWriteScope(), asSessionId(id))
    expect(column(id)).toBeUndefined()
  })

  it('follows the many-row upsert', async () => {
    const ids = ['s-many-a', 's-many-b', 's-many-c']
    const write = async (states: (AgentRuntimeState | undefined)[]) => {
      const next = ids.map((id, i) => ({ ...(rows.get(id) ?? row(id)), agentState: states[i] }))
      for (const r of next) rows.set(r.id, r)
      await store.sessions.upsertSessions(fixtureWriteScope(), next)
    }
    await write([state('needs_user'), state('working'), undefined])
    await follows('s-many-a', true)
    await follows('s-many-b', false)
    await follows('s-many-c', false)
    await write([state('working'), state('errored'), state('idle', 'question')])
    await follows('s-many-a', false)
    await follows('s-many-b', true)
    await follows('s-many-c', true)
  })
})

describe('the migration backfills asks_user from the rule', () => {
  it('sets it on the sessions that ask, and only those', () => {
    const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_session-asks-user'))
    expect(cut).toBeGreaterThan(0)
    const db = openDatabase(':memory:')
    try {
      runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
      const ownerId = 'u-owner'
      db.prepare(
        "INSERT INTO users (id, display_name, role, created_at) VALUES (?, 'Owner', 'admin', '2026-10-01')",
      ).run(ownerId)
      const session = db.prepare(
        `INSERT INTO sessions (id, agent_kind, cwd, title, origin_kind, status, durable_label,
           created_at, last_active_at, machine_id, owner_user_id, agent_state_json, archived,
           deleted_at, last_input_at)
         VALUES (?, 'codex', '/p', ?, 'spawn', 'live', ?, '2026-11-01', '2026-11-01', 'local', ?,
           ?, ?, ?, ?)`,
      )
      const plant = (
        id: string,
        agentState: AgentRuntimeState | null,
        more: { archived?: boolean; deletedAt?: string; lastInputAt?: string } = {},
      ) =>
        session.run(
          id,
          id,
          `l-${id}`,
          ownerId,
          agentState === null ? null : JSON.stringify(agentState),
          more.archived ? 1 : 0,
          more.deletedAt ?? null,
          more.lastInputAt ?? null,
        )
      plant('b-needs', state('needs_user'))
      plant('b-working', state('working'))
      plant('b-question', state('idle', 'question'))
      plant('b-archived', state('errored'), { archived: true })
      plant('b-deleted', state('errored'), { deletedAt: '2026-11-02' })
      plant('b-offer', null)
      plant('b-stale-offer', null, { lastInputAt: '2026-11-03' })
      plant('b-checkpoint', state('needs_user'))
      plant('b-runtime', state('working'))
      const offer = db.prepare(
        "INSERT INTO offers (session_id, message, actions, created_at) VALUES (?, 'Ready', '[]', ?)",
      )
      offer.run('b-offer', '2026-11-02')
      offer.run('b-stale-offer', '2026-11-02')
      db.prepare(
        `INSERT INTO session_observation_checkpoints (session_id, provider, checkpoint_json, updated_at)
         VALUES ('b-checkpoint', 'codex', ?, '2026-11-02')`,
      ).run(JSON.stringify({ turnState: state('working') }))
      db.prepare(
        `INSERT INTO runtime_event_checkpoints (session_id, observer_generation, cursor_json,
           turn_epoch, updated_at, turn_state_json)
         VALUES ('b-runtime', 1, '{}', 1, '2026-11-02', ?)`,
      ).run(JSON.stringify(state('errored')))

      runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))

      const asking = (
        db.prepare('SELECT id FROM sessions WHERE asks_user = 1 ORDER BY id').all() as {
          id: SessionId
        }[]
      ).map((r) => r.id)
      expect(asking).toEqual(['b-needs', 'b-offer', 'b-question', 'b-runtime'])
    } finally {
      db.close()
    }
  })
})
