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
import { and, eq, type SQL, sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { SQLiteDialect } from 'drizzle-orm/sqlite-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runDrizzleMigrations } from '../migrations'
import { DRIZZLE_MIGRATIONS } from '../migrations/drizzle-manifest.generated'
import * as pgSchema from '../migrations/pg/schema'
import { sqliteAskingSchema } from '../migrations/session-asks-user'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import type { SessionStore } from '../store'
import { captureWrite } from '../sync/capture-pg'
import { ASKS_USER_CLAUSES } from '../sync/collection-sql'
import { type RecordReads, serverRecordBuilders } from '../sync/record-builders'
import { issueRowFixture } from '../test-support/issue-row'
import { openTestStore } from '../test-support/open-test-store'
import { testStoreEngine } from '../test-support/pg-test-database'
import { countRoundTrips } from '../test-support/round-trip-count'
import { storeSql } from '../test-support/store-sql'
import type { LegacyWorkspaceQueries } from './executor/sync-drizzle'
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
      machineId: asMachineId(store.hostMachine!.id),
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
    await pinned('session upsert', () => store.sessions.upsertSession(fixtureWriteScope(), next))
  }

  /** Maintenance stays in the source statement: one statement, one round trip on both engines. */
  async function pinned(name: string, write: () => Promise<void>): Promise<void> {
    const { statements, roundTrips, byCall } = await countRoundTrips(store, write)
    expect({ statements, roundTrips }, `${name}: ${JSON.stringify([...byCall])}`).toEqual({
      statements: 1,
      roundTrips: 1,
    })
  }

  const column = async (id: string): Promise<number | undefined> =>
    (
      await storeSql(store).get<{ asks_user: number }>(
        sql`SELECT CAST(asks_user AS INTEGER) AS asks_user FROM sessions WHERE workspace_id = ${store.workspaceId} AND id = ${id}`,
      )
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
    expect(await column(id), `asks_user of ${id}`).toBe(asks ? 1 : 0)
  }

  async function checkpoint(id: string, turnState: AgentRuntimeState): Promise<void> {
    const sessionId = asSessionId(id)
    const lease = await store.observationCheckpoints.get(sessionId)
    if (lease === null) {
      await store.observationCheckpoints.advanceGeneration(sessionId, 'codex', `thread-${id}`)
      checkpointGeneration = 1
    }
    await pinned('observation checkpoint save', () =>
      store.observationCheckpoints.save({
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
      }),
    )
  }

  async function runtime(id: string, turnState: AgentRuntimeState | undefined): Promise<void> {
    await pinned('runtime checkpoint upsert', () =>
      store.events.saveRuntimeEventCheckpoint({
        sessionId: asSessionId(id),
        observerGeneration: 1,
        cursor: { segmentId: 'rollout-1', components: { file: 42 } },
        turnEpoch: 1,
        closedTurnEpoch: null,
        updatedAt: at(-1),
        ...(turnState ? { turnState } : {}),
      }),
    )
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
    expect(await column(id)).toBeUndefined()
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

  it('pins offers, checkpoint deletes and 5/200-row session batches at one statement and one round trip', async () => {
    const id = asSessionId('s-pinned')
    await upsert(id, { agentState: state('working') })
    await pinned('offer insert', () =>
      store.sessions.setOffer(fixtureWriteScope(), id, {
        message: 'Ready',
        actions: [],
        createdAt: at(-1),
      }),
    )
    await follows(id, true)
    await pinned('offer replacement', () =>
      store.sessions.setOffer(fixtureWriteScope(), id, {
        message: 'Ready again',
        actions: [],
        createdAt: at(0),
      }),
    )
    await pinned('offer delete', () => store.sessions.clearOffer(fixtureWriteScope(), id))
    await follows(id, false)
    await checkpoint(id, state('needs_user'))
    await follows(id, true)
    await pinned('observation checkpoint delete', () => store.observationCheckpoints.purge(id))
    await follows(id, false)
    for (const size of [5, 200]) {
      const batch = Array.from({ length: size }, (_, index) =>
        row(`pin-${size}-${index}`, { agentState: state('needs_user') }),
      )
      await pinned(`${size}-row insert`, () =>
        store.sessions.upsertSessions(fixtureWriteScope(), batch),
      )
      expect(await column(batch[0]!.id)).toBe(1)
      const updated = batch.map((row) => ({ ...row, agentState: state('working') }))
      await pinned(`${size}-row upsert`, () =>
        store.sessions.upsertSessions(fixtureWriteScope(), updated),
      )
      expect(await column(batch[0]!.id)).toBe(0)
    }
  })

  it('updates flags inside the transaction and rolls them back with the source writes', async () => {
    const id = 's-rollback'
    await upsert(id, { agentState: state('working') })
    await expect(
      store.transact(async () => {
        await upsert(id, { agentState: state('needs_user') })
        expect(await column(id)).toBe(1)
        await runtime(id, state('working'))
        expect(await column(id)).toBe(0)
        throw new Error('roll back asking inputs')
      }),
    ).rejects.toThrow('roll back asking inputs')
    await follows(id, false)
  })

  it.runIf(testStoreEngine() === 'sqlite')(
    'renders the exact installed SQLite view and every trigger from the shared declaration',
    async () => {
      const dialect = new SQLiteDialect()
      const declared = sqliteAskingSchema((query) => dialect.sqlToQuery(query).sql)
      const installed = await storeSql(store).all<{ name: string; sql: string }>(
        sql`SELECT name, sql FROM sqlite_schema WHERE name = 'session_asks_user' OR name LIKE 'asks_user__%' ORDER BY name`,
      )
      const normalize = (text: string) => text.replaceAll(/["`;\s]/g, '').toLowerCase()
      expect(installed.map(({ name }) => name).sort()).toEqual([...declared.keys()].sort())
      for (const { name, sql: statement } of installed) {
        expect(normalize(statement), name).toBe(normalize(declared.get(name)!))
      }
    },
  )
})

describe.runIf(testStoreEngine() === 'pg')('asks_user maintenance on Postgres (POD-7587)', () => {
  /** Every node of an `EXPLAIN (FORMAT JSON)` plan, subplans and CTEs included. */
  type PlanNode = { 'Node Type': string; 'Actual Loops'?: number; Plans?: PlanNode[] }
  const nodesOf = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodesOf)]

  it('computes the value for the written sessions only, however low the row estimates are', async () => {
    const store = await openTestStore(':memory:')
    try {
      const raw = storeSql(store)
      const owner = await firstAdminMemberId(store)
      const host = store.hostMachine
      if (host === undefined || host === null) throw new Error('the test store has no host machine')
      const machineId = asMachineId(host.id)
      const session = (id: string): SessionRow => ({
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
        status: 'exited',
        exitCode: 0,
        spawnFailure: null,
        durableLabel: `podium-${id}`,
        createdAt: at(-600),
        lastActiveAt: at(-1),
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
        createdBy: { actor: actorUser(owner), onBehalfOf: owner },
      })
      const sessions = (from: number, to: number) =>
        Array.from({ length: to - from }, (_, n) => session(`estimate-${from + n}`))
      const leases = async (from: number, to: number) => {
        for (let n = from; n < to; n++)
          await store.observationCheckpoints.advanceGeneration(
            asSessionId(`estimate-${n}`),
            'codex',
            null,
          )
      }
      await store.sessions.upsertSessions(fixtureWriteScope(), sessions(0, 304))
      await leases(0, 304)
      // Statistics that call both tables nearly empty while they hold 304 rows each, as they
      // stay through a transaction that grew them: no ANALYZE sees uncommitted rows, and a
      // plan made early keeps its estimates (POD-7587). Four rows over a thousand pages put
      // the planner's estimate for the tables' present size at about one row. No
      // autovacuum may correct them before the statement is planned.
      for (const table of ['sessions', 'session_observation_checkpoints'])
        await raw.run(sql.raw(`ALTER TABLE ${table} SET (autovacuum_enabled = false)`))
      await raw.run(
        sql`UPDATE pg_class SET reltuples = 4, relpages = 1000 WHERE oid IN ('sessions'::regclass, 'session_observation_checkpoints'::regclass)`,
      )

      // A satellite write: one session's checkpoint saved over its lease, as `save` writes
      // it. The store's drizzle is typed as SQLite's; on this engine it builds Postgres writes.
      const { queries } = store as unknown as { queries: LegacyWorkspaceQueries }
      const pg = queries.rootDb as unknown as {
        update(table: unknown): {
          set(values: Record<string, unknown>): {
            where(condition: SQL | undefined): { getSQL(): SQL }
          }
        }
      }
      const checkpoints = pgSchema.sessionObservationCheckpoints
      const write = captureWrite(
        pg
          .update(checkpoints)
          .set({
            checkpointJson: JSON.stringify({ schemaVersion: 1, turnState: state('needs_user') }),
            updatedAt: at(0),
          })
          .where(
            and(
              eq(checkpoints.workspaceId, SELF_HOSTED_WORKSPACE_ID),
              eq(checkpoints.sessionId, asSessionId('estimate-7')),
            ),
          ),
      )
      // Run it as the driver does: a prepared statement on its generic plan, the plan
      // Postgres keeps after five executions, made without the parameter values.
      const { sql: text, params } = new PgDialect().sqlToQuery(write.getSQL())
      const literal = (value: unknown): string =>
        value === null
          ? 'NULL'
          : typeof value === 'number'
            ? String(value)
            : `'${String(value).replaceAll("'", "''")}'`
      const plan = await raw.transaction(async () => {
        await raw.run(sql`SET LOCAL plan_cache_mode = force_generic_plan`)
        await raw.run(sql.raw(`PREPARE asks_estimate_probe AS ${text}`))
        try {
          const [row] = await raw.all<{ 'QUERY PLAN': unknown }>(
            sql.raw(
              `EXPLAIN (ANALYZE, FORMAT JSON) EXECUTE asks_estimate_probe(${params.map(literal).join(', ')})`,
            ),
          )
          const value = row?.['QUERY PLAN']
          return (typeof value === 'string' ? JSON.parse(value) : value) as [{ Plan: PlanNode }]
        } finally {
          await raw.run(sql`DEALLOCATE asks_estimate_probe`)
        }
      })
      // One updated row: nothing that computes the value runs more than once for it and its
      // old image. Inlined, the value and its lookups ran once per session of the table
      // (POD-7587). Reading a materialized one-row CTE once per row of a sequential scan is
      // that scan's own cost, linear in the table; the driver's re-planning removes it once
      // the transaction has grown (`pg-driver.test.ts`).
      const readsCte = (node: PlanNode): boolean =>
        node['Node Type'] === 'CTE Scan' ||
        (node['Node Type'] === 'Append' && (node.Plans ?? []).every(readsCte))
      const repeated = nodesOf(plan[0].Plan)
        .filter((node) => (node['Actual Loops'] ?? 0) > 2 && !readsCte(node))
        .map((node) => `${node['Node Type']} x${node['Actual Loops']}`)
      expect(repeated).toEqual([])
      // The write applied, and the flag follows the checkpoint's turn state.
      expect(await column(store, 'estimate-7')).toBe(1)
    } finally {
      await store.close()
    }
  })

  const column = async (store: SessionStore, id: string) =>
    (
      await storeSql(store).get<{ asks: number }>(
        sql`SELECT CASE WHEN asks_user THEN 1 ELSE 0 END AS asks FROM sessions WHERE id = ${id}`,
      )
    )?.asks
})

describe.runIf(testStoreEngine() === 'sqlite')(
  'the migration backfills asks_user from the rule',
  () => {
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
  },
)
