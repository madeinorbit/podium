// workspace-scoped (POD-6959)
/**
 * Automations aggregate (#470) [spec:SP-17db] — owns the `automations` and
 * `automation_runs` tables (timestamped automations migrations). Pure persistence: the schedule
 * SEMANTICS (cron parsing, the due/missed/overlap decision, the spawn) live in
 * modules/automations/.
 */

import type {
  AutomationId,
  AutomationRunId,
  AutomationRunOutcome,
  AutomationRunWire,
  AutomationScheduleKind,
  AutomationSessionMode,
  AutomationWire,
  SessionId,
  UserId,
} from '@podium/model'
import type { WriteScope } from '@podium/sync'
import { and, asc, desc, eq, isNull, type SQL, sql } from 'drizzle-orm'
import type { automationRuns, automations } from '../migrations/schema'
import { captureWrite } from '../sync/capture-pg'
import { dialectOf } from './executor/dialect-prepared'
import type {
  StoreDrizzle,
  StoreTables,
  TransactionRunner,
  WorkspaceDb,
  WorkspaceQueries,
} from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  inWorkspace,
  param,
  prepared,
  preparedFamily,
  sameWorkspace,
  WORKSPACE,
} from './executor/sync-drizzle'

export type { AutomationRunOutcome } from '@podium/model'
export type AutomationRow = AutomationWire & {
  ownerUserId: UserId
  createdByActor: string
  createdByOnBehalfOf: UserId
}
export type AutomationRunRow = AutomationRunWire & {
  actor: string
  onBehalfOf: UserId
}

/**
 * WHAT STILL NEEDS MAPPING, AND WHY EACH LINE IS HERE [spec §6 rules 3 and 6].
 *
 * Drizzle's own execution path returns the schema's TypeScript names and its
 * `$type` brands, so the per-column decode this file used to carry is gone —
 * `id`, `targetSessionId`, `ownerUserId`, `enabled` (an `integer({ mode:
 * 'boolean' })` column) and every plain string arrive correctly typed. What is
 * left is the two places where the SCHEMA'S type is looser than the DOMAIN'S,
 * and each is a decision rather than a driver artefact:
 *
 *   `cron` is `notNull` in the database and nullable in the domain. A
 *   non-cron automation stores the empty string and reads back as null; the
 *   write half of that pair is in {@link AutomationsRepository.update}. Neither
 *   half means anything without the other.
 *
 *   `scheduleKind`, `sessionMode` and `outcome` are CHECK-constrained text in
 *   the database and unions in the domain. The database enforces the values
 *   (spec §6 rule 5), so this narrows what the constraint already guarantees.
 */
/** RETAINED EXTERNAL-INPUT BRAND CASTS: lookup and patch methods still accept
 * service-facing string ids. Their query casts decode inputs; selected ids flow
 * from the schema without casts. */
type AutomationSelect = typeof automations.$inferSelect
type AutomationRunSelect = typeof automationRuns.$inferSelect

function rowToAutomation(r: AutomationSelect): AutomationRow {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    repoPath: r.repoPath,
    scheduleKind: r.scheduleKind as AutomationScheduleKind,
    cron: r.cron || null,
    runAt: r.runAt,
    targetSessionId: r.targetSessionId,
    agentKind: r.agentKind,
    model: r.model,
    effort: r.effort,
    prompt: r.prompt,
    sessionMode: r.sessionMode as AutomationSessionMode,
    nextRunAt: r.nextRunAt,
    lastRunAt: r.lastRunAt,
    createdAt: r.createdAt,
    ownerUserId: r.ownerUserId,
    createdByActor: r.createdByActor,
    createdByOnBehalfOf: r.createdByOnBehalfOf,
  }
}

function rowToRun(r: AutomationRunSelect): AutomationRunRow {
  return {
    id: r.id,
    automationId: r.automationId,
    firedAt: r.firedAt,
    sessionId: r.sessionId,
    outcome: r.outcome as AutomationRunOutcome,
    detail: r.detail,
    actor: r.actor,
    onBehalfOf: r.onBehalfOf,
  }
}

// Every query this repository runs, prepared once per store [POD-6147].

const P = (name: string) => sql.placeholder(name)
const automationIdIs = (t: StoreTables) => eq(t.automations.id, param(t.automations.id, 'id'))
const runIdIs = (t: StoreTables) => eq(t.automationRuns.id, param(t.automationRuns.id, 'id'))

const liveAutomations = prepared((db, t) =>
  db
    .select()
    .from(t.automations)
    .where(inWorkspace(t.automations, isNull(t.automations.deletedAt)))
    .orderBy(asc(t.automations.createdAt))
    .prepare(),
)

const liveAutomationById = prepared((db, t) =>
  db
    .select()
    .from(t.automations)
    .where(inWorkspace(t.automations, automationIdIs(t), isNull(t.automations.deletedAt)))
    .prepare(),
)

// THE ABSENT `isNull(deletedAt)` IS THE POINT (see `ownerOf`).
const automationOwner = prepared((db, t) =>
  db
    .select({ ownerUserId: t.automations.ownerUserId })
    .from(t.automations)
    .where(inWorkspace(t.automations, automationIdIs(t)))
    .prepare(),
)

const runOwner = prepared((db, t) =>
  db
    .select({ ownerUserId: t.automations.ownerUserId })
    .from(t.automationRuns)
    .innerJoin(
      t.automations,
      and(
        sameWorkspace(t.automations, t.automationRuns),
        eq(t.automations.id, t.automationRuns.automationId),
      ),
    )
    .where(inWorkspace(t.automationRuns, runIdIs(t)))
    .prepare(),
)

// The batched forms of `automationOwner` / `runOwner` [POD-6149]: the same
// unfiltered reads, keyed by id, one statement per IN-list chunk.
const automationOwnersOfIds = preparedFamily((db, t, size: number) =>
  db
    .select({ id: t.automations.id, ownerUserId: t.automations.ownerUserId })
    .from(t.automations)
    .where(inWorkspace(t.automations, inListOf(t.automations.id, size)))
    .prepare(),
)

const runOwnersOfIds = preparedFamily((db, t, size: number) =>
  db
    .select({ id: t.automationRuns.id, ownerUserId: t.automations.ownerUserId })
    .from(t.automationRuns)
    .innerJoin(
      t.automations,
      and(
        sameWorkspace(t.automations, t.automationRuns),
        eq(t.automations.id, t.automationRuns.automationId),
      ),
    )
    .where(inWorkspace(t.automationRuns, inListOf(t.automationRuns.id, size)))
    .prepare(),
)

/** Under SQLite's bound-parameter limit, like the other batched readers. */
const OWNER_CHUNK = 500

/** Live automations and live runs by id, for building records by id (POD-6763). */
const liveAutomationsOfIds = preparedFamily((db, t, size: number) =>
  db
    .select()
    .from(t.automations)
    .where(
      inWorkspace(t.automations, inListOf(t.automations.id, size), isNull(t.automations.deletedAt)),
    )
    .prepare(),
)

const liveRunsOfIds = preparedFamily((db, t, size: number) =>
  db
    .select()
    .from(t.automationRuns)
    .where(
      inWorkspace(
        t.automationRuns,
        inListOf(t.automationRuns.id, size),
        isNull(t.automationRuns.deletedAt),
      ),
    )
    .prepare(),
)

const automationColumns = {
  name: P('name'),
  enabled: P('enabled'),
  repoPath: P('repoPath'),
  scheduleKind: P('scheduleKind'),
  cron: P('cron'),
  runAt: P('runAt'),
  targetSessionId: P('targetSessionId'),
  agentKind: P('agentKind'),
  model: P('model'),
  effort: P('effort'),
  prompt: P('prompt'),
  sessionMode: P('sessionMode'),
  nextRunAt: P('nextRunAt'),
  lastRunAt: P('lastRunAt'),
}

const insertAutomation = prepared((db, t) =>
  captureWrite(
    db.insert(t.automations).values({
      workspaceId: WORKSPACE,
      id: P('id'),
      ...automationColumns,
      createdAt: P('createdAt'),
      ownerUserId: P('ownerUserId'),
      createdByActor: P('createdByActor'),
      createdByOnBehalfOf: P('createdByOnBehalfOf'),
    }),
  ).prepare(),
)

const updateAutomation = prepared((db, t) =>
  captureWrite(
    db
      .update(t.automations)
      .set(automationColumns)
      .where(inWorkspace(t.automations, automationIdIs(t))),
  ).prepare(),
)

const tombstoneAutomation = prepared((db, t) =>
  captureWrite(
    db
      .update(t.automations)
      .set({ deletedAt: P('deletedAt') })
      .where(inWorkspace(t.automations, automationIdIs(t), isNull(t.automations.deletedAt))),
  ).prepare(),
)

const tombstoneRunsOf = prepared((db, t) =>
  captureWrite(
    db
      .update(t.automationRuns)
      .set({ deletedAt: P('deletedAt') })
      .where(
        inWorkspace(
          t.automationRuns,
          eq(t.automationRuns.automationId, param(t.automationRuns.automationId, 'id')),
          isNull(t.automationRuns.deletedAt),
        ),
      ),
  ).prepare(),
)

const insertRun = prepared((db, t) =>
  captureWrite(
    db.insert(t.automationRuns).values({
      workspaceId: WORKSPACE,
      id: P('id'),
      automationId: P('automationId'),
      firedAt: P('firedAt'),
      sessionId: P('sessionId'),
      outcome: P('outcome'),
      detail: P('detail'),
      actor: P('actor'),
      onBehalfOf: P('onBehalfOf'),
    }),
  ).prepare(),
)

const liveRunById = prepared((db, t) =>
  db
    .select()
    .from(t.automationRuns)
    .where(inWorkspace(t.automationRuns, runIdIs(t), isNull(t.automationRuns.deletedAt)))
    .prepare(),
)

const finalizeRun = prepared((db, t) =>
  captureWrite(
    db
      .update(t.automationRuns)
      .set({ sessionId: P('sessionId'), outcome: P('outcome'), detail: P('detail') })
      .where(inWorkspace(t.automationRuns, runIdIs(t), isNull(t.automationRuns.deletedAt))),
  ).prepare(),
)

// INSERTION ORDER, PER ENGINE. SQLite breaks a `fired_at` tie by rowid and names the
// latest spawned run by MAX(rowid): insertion order, which is the truth about which
// ran last when two fires share a timestamp or one is recorded out of order (see
// `lastSpawnedSessions`). Postgres has no rowid and the table no insertion counter,
// so its forms order by `fired_at` and break a tie by the primary key: the same
// answer whenever the runs were recorded in the order they fired.
const runTieBreak = (db: StoreDrizzle, t: StoreTables): SQL =>
  dialectOf(db) === 'pg' ? sql`${t.automationRuns.id}` : sql`rowid`

const runsOfAutomation = prepared((db, t) =>
  db
    .select()
    .from(t.automationRuns)
    .where(
      inWorkspace(
        t.automationRuns,
        eq(t.automationRuns.automationId, param(t.automationRuns.automationId, 'automationId')),
        isNull(t.automationRuns.deletedAt),
      ),
    )
    // The tie-break makes the order TOTAL: two fires can share a
    // timestamp, and without it the page is whatever the engine returns.
    .orderBy(desc(t.automationRuns.firedAt), desc(runTieBreak(db, t)))
    .limit(P('limit'))
    .prepare(),
)

const allLiveRuns = prepared((db, t) =>
  db
    .select()
    .from(t.automationRuns)
    .where(inWorkspace(t.automationRuns, isNull(t.automationRuns.deletedAt)))
    .orderBy(asc(t.automationRuns.firedAt), asc(runTieBreak(db, t)))
    .prepare(),
)

/** The live run ids of one automation, through its index (POD-6172). */
const liveRunIdsOf = prepared((db, t) =>
  db
    .select({ id: t.automationRuns.id })
    .from(t.automationRuns)
    .where(
      inWorkspace(
        t.automationRuns,
        eq(t.automationRuns.automationId, param(t.automationRuns.automationId, 'automationId')),
        isNull(t.automationRuns.deletedAt),
      ),
    )
    .prepare(),
)

// THE LATEST SPAWNED RUN OF AN AUTOMATION: a correlated subquery over its runs,
// which the builder has no vocabulary for, so it stays a `sql` fragment inside the
// builder query (rule 1). The subquery seeks `idx_automation_runs_automation`.
// `workspace` holds `x` to the caller's workspace in the subquery's own scope:
// the placeholder, or the correlated automation's own column (POD-6959).
//
// On SQLite `MAX(rowid)`, not `MAX(fired_at)`: see `lastSpawnedSessions`. On
// Postgres the newest by `fired_at`, a tie broken by the primary key (above).
const isLatestSpawnedRun = (
  db: StoreDrizzle,
  t: StoreTables,
  automationId: SQL,
  workspace: SQL,
): SQL => {
  const spawned = sql`x.workspace_id = ${workspace}
      AND x.automation_id = ${automationId}
      AND x.outcome = 'spawned' AND x.session_id IS NOT NULL
      AND x.deleted_at IS NULL`
  return dialectOf(db) === 'pg'
    ? sql`${t.automationRuns.id} = (
    SELECT x.id FROM automation_runs x
    WHERE ${spawned}
    ORDER BY x.fired_at DESC, x.id DESC LIMIT 1
  )`
    : sql`${t.automationRuns}.rowid = (
    SELECT MAX(x.rowid) FROM automation_runs x
    WHERE ${spawned}
  )`
}

// Driven from `automations` (a small table) rather than from every run
// (POD-6172): one index seek per automation instead of a read of every run.
// Every run names an existing automation (the foreign key), so no run is missed.
const lastSpawnedRuns = prepared((db, t) =>
  db
    .select({
      automationId: t.automationRuns.automationId,
      sessionId: t.automationRuns.sessionId,
    })
    .from(t.automations)
    .innerJoin(
      t.automationRuns,
      and(
        sameWorkspace(t.automationRuns, t.automations),
        isLatestSpawnedRun(db, t, sql`${t.automations.id}`, sql`${t.automations.workspaceId}`),
      ),
    )
    .where(inWorkspace(t.automations))
    .prepare(),
)

const lastSpawnedRunOf = prepared((db, t) =>
  db
    .select({ sessionId: t.automationRuns.sessionId })
    .from(t.automationRuns)
    .where(
      inWorkspace(
        t.automationRuns,
        isLatestSpawnedRun(db, t, sql`${sql.placeholder('automationId')}`, sql`${WORKSPACE}`),
      ),
    )
    .prepare(),
)

/** The rewritable columns of one automation, as placeholder values. */
function automationValues(a: AutomationRow) {
  return {
    name: a.name,
    enabled: a.enabled,
    repoPath: a.repoPath,
    scheduleKind: a.scheduleKind,
    // The write half of the null-cron pair; the read half is in
    // `rowToAutomation`. The column is `notNull` and the domain is not.
    cron: a.cron ?? '',
    runAt: a.runAt,
    targetSessionId: a.targetSessionId,
    agentKind: a.agentKind,
    model: a.model,
    effort: a.effort,
    prompt: a.prompt,
    sessionMode: a.sessionMode,
    nextRunAt: a.nextRunAt,
    lastRunAt: a.lastRunAt,
  }
}

export class AutomationsRepository {
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * The query builder every method below reads through [spec rules 34, 34a].
   *
   * A GETTER, not a field assigned in the constructor: rule 35 makes transaction
   * routing ambient, so this has to resolve the ENCLOSING transaction on every
   * access, and a field frozen at construction never could. B1 changes this one
   * line; no call site moves.
   */
  protected get db(): WorkspaceDb {
    return this.scope
  }

  async list(): Promise<AutomationRow[]> {
    return (await liveAutomations(this.db).all()).map(rowToAutomation)
  }

  async get(id: string): Promise<AutomationRow | undefined> {
    const r = await liveAutomationById(this.db).get({ id: id as AutomationId })
    return r ? rowToAutomation(r) : undefined
  }

  /**
   * THE OWNER OF A ROW THAT MAY ALREADY BE GONE (POD-1509).
   *
   * The one read that deliberately looks THROUGH the tombstone, and the reason
   * the tombstone exists. A commit writes before it scopes, so when the scoped
   * feed evaluates a `remove` the row is already deleted; an owner lookup that
   * respected the tombstone would answer `undefined`, the policy would refuse
   * the row as `personal-not-granted`, and the deletion would reach the client
   * as an empty watermark — delivered-but-not-sent. Ownership is therefore the
   * one fact about an automation that outlives it.
   *
   * NOT a general `getIncludingRemoved`: this returns an owner and nothing else,
   * so no caller can accidentally resurrect a deleted automation's payload by
   * reaching for a field that happens to still be in the row.
   *
   * THE ABSENT `isNull(deletedAt)` IS THE POINT, not an omission. Every other
   * read in this file carries one; a conversion that made this file internally
   * consistent would break the scoped feed silently.
   */
  async ownerOf(id: string): Promise<UserId | undefined> {
    return (await automationOwner(this.db).get({ id: id as AutomationId }))?.ownerUserId
  }

  /** The owning user of a run's automation, through both tombstones. Same
   *  contract and the same reason as {@link ownerOf}. */
  async runOwnerOf(id: string): Promise<UserId | undefined> {
    return (await runOwner(this.db).get({ id: id as AutomationRunId }))?.ownerUserId
  }

  /** {@link ownerOf} for many automations in one read per 500 ids. An id with
   *  no row is absent from the map, which callers read as "no owner". */
  async ownersOf(ids: readonly string[]): Promise<Map<string, UserId>> {
    const out = new Map<string, UserId>()
    const unique = [...new Set(ids)]
    for (let at = 0; at < unique.length; at += OWNER_CHUNK) {
      const chunk = unique.slice(at, at + OWNER_CHUNK)
      const size = inListSize(chunk.length)
      for (const row of await automationOwnersOfIds(this.db, size).all(inListValues(chunk, size))) {
        out.set(row.id, row.ownerUserId)
      }
    }
    return out
  }

  /** {@link runOwnerOf} for many runs in one read per 500 ids; same contract. */
  async runOwnersOf(ids: readonly string[]): Promise<Map<string, UserId>> {
    const out = new Map<string, UserId>()
    const unique = [...new Set(ids)]
    for (let at = 0; at < unique.length; at += OWNER_CHUNK) {
      const chunk = unique.slice(at, at + OWNER_CHUNK)
      const size = inListSize(chunk.length)
      for (const row of await runOwnersOfIds(this.db, size).all(inListValues(chunk, size))) {
        out.set(row.id, row.ownerUserId)
      }
    }
    return out
  }

  /** {@link get} for many ids, one read per 500; an absent id has no live row. */
  async getMany(ids: readonly string[]): Promise<AutomationRow[]> {
    const out: AutomationRow[] = []
    const unique = [...new Set(ids)]
    for (let at = 0; at < unique.length; at += OWNER_CHUNK) {
      const chunk = unique.slice(at, at + OWNER_CHUNK)
      const size = inListSize(chunk.length)
      for (const row of await liveAutomationsOfIds(this.db, size).all(inListValues(chunk, size)))
        out.push(rowToAutomation(row))
    }
    return out
  }

  /** {@link getRun} for many ids, one read per 500; same contract as {@link getMany}. */
  async getRuns(ids: readonly string[]): Promise<AutomationRunRow[]> {
    const out: AutomationRunRow[] = []
    const unique = [...new Set(ids)]
    for (let at = 0; at < unique.length; at += OWNER_CHUNK) {
      const chunk = unique.slice(at, at + OWNER_CHUNK)
      const size = inListSize(chunk.length)
      for (const row of await liveRunsOfIds(this.db, size).all(inListValues(chunk, size)))
        out.push(rowToRun(row))
    }
    return out
  }

  async insert(_scope: WriteScope, a: AutomationRow): Promise<void> {
    await insertAutomation(this.db).run({
      id: a.id,
      ...automationValues(a),
      createdAt: a.createdAt,
      ownerUserId: a.ownerUserId,
      createdByActor: a.createdByActor,
      createdByOnBehalfOf: a.createdByOnBehalfOf,
    })
  }

  /** Whole-row update (the service reads, patches, writes back). */
  async update(_scope: WriteScope, a: AutomationRow): Promise<void> {
    await updateAutomation(this.db).run({ id: a.id, ...automationValues(a) })
  }

  /**
   * Delete an automation and its runs — as TOMBSTONES, not as a `DELETE`.
   *
   * Every read above filters `deleted_at IS NULL`, so this is invisible to the
   * service, the wire and the UI: `get` and `list` stop returning the row, the
   * feed still carries an explicit `op: 'remove'`, and nothing anywhere reads
   * absence as deletion. What survives is the OWNERSHIP the scoped feed needs to
   * decide who the removal is for — see {@link ownerOf}.
   *
   * The runs are stamped EXPLICITLY. They used to leave through the
   * `ON DELETE CASCADE` on `automation_runs.automation_id`, which no longer
   * fires now that the parent row stays; a cascade that silently stopped
   * happening would leave every run of a deleted automation live and listable.
   */
  async remove(_scope: WriteScope, id: string, deletedAt: string): Promise<boolean> {
    const removed =
      Number(
        (await tombstoneAutomation(this.db).run({ id: id as AutomationId, deletedAt })).changes,
      ) > 0
    if (removed) {
      await tombstoneRunsOf(this.db).run({ id: id as AutomationId, deletedAt })
    }
    return removed
  }

  // ---- runs ----

  async addRun(_scope: WriteScope, run: AutomationRunRow): Promise<void> {
    await insertRun(this.db).run({
      id: run.id,
      automationId: run.automationId,
      firedAt: run.firedAt,
      sessionId: run.sessionId,
      outcome: run.outcome,
      detail: run.detail,
      actor: run.actor,
      onBehalfOf: run.onBehalfOf,
    })
  }

  async getRun(id: string): Promise<AutomationRunRow | undefined> {
    const r = await liveRunById(this.db).get({ id: id as AutomationRunId })
    return r ? rowToRun(r) : undefined
  }

  /** Finalize a reserved occurrence after side effects [POD-925]. A tombstoned
   *  run is not finalizable: its automation is gone and the row is history. */
  async updateRun(
    _scope: WriteScope,
    id: string,
    patch: { sessionId: SessionId | null; outcome: AutomationRunOutcome; detail: string | null },
  ): Promise<void> {
    await finalizeRun(this.db).run({
      id: id as AutomationRunId,
      sessionId: patch.sessionId,
      outcome: patch.outcome,
      detail: patch.detail,
    })
  }

  /** Most recent runs first — the tab's "Recent runs" list. */
  async listRuns(automationId: AutomationId, limit = 20): Promise<AutomationRunRow[]> {
    return (await runsOfAutomation(this.db).all({ automationId, limit })).map(rowToRun)
  }

  /** Full run truth for durable snapshots and boot reconciliation. */
  async listAllRuns(): Promise<AutomationRunRow[]> {
    return (await allLiveRuns(this.db).all()).map(rowToRun)
  }

  /** The session id of the LATEST spawned run, per automation — the overlap check's
   *  input ("is the previous run's session still live?"). Automations that never
   *  spawned are absent from the map. On SQLite latest = highest rowid (insertion
   *  order), not MAX(fired_at): two fires can share a timestamp, and insertion order
   *  is the truth about which ran last. On Postgres, which keeps no insertion order,
   *  latest = newest `fired_at`, a tie broken by the run id. */
  async lastSpawnedSessions(): Promise<Map<AutomationId, SessionId>> {
    const rows = await lastSpawnedRuns(this.db).all()
    return new Map(
      rows.flatMap((r) => (r.sessionId === null ? [] : [[r.automationId, r.sessionId] as const])),
    )
  }

  /** {@link lastSpawnedSessions} for one automation: undefined when it never spawned. */
  async lastSpawnedSessionOf(automationId: AutomationId): Promise<SessionId | undefined> {
    return (await lastSpawnedRunOf(this.db).get({ automationId }))?.sessionId ?? undefined
  }

  /** The ids of one automation's live runs. */
  async liveRunIdsOf(automationId: AutomationId): Promise<AutomationRunId[]> {
    return (await liveRunIdsOf(this.db).all({ automationId })).map((r) => r.id)
  }
}
