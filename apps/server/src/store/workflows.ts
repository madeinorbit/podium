import { AgentProfileWire, type SessionId, type UserId } from '@podium/model'
import {
  type WorkflowGitObservation as GitObservation,
  type WorkflowRunStepWire as RunStep,
  type WorkflowStep as Step,
  type WorkflowStepEvidence as StepEvidence,
  type WorkflowBindingTarget,
  type WorkflowBindingWire,
  WorkflowGitObservation,
  type WorkflowRevisionWire,
  type WorkflowRunEventWire,
  type WorkflowRunStatus,
  type WorkflowRunStepStatus,
  WorkflowRunStepWire,
  type WorkflowScope,
  WorkflowStep,
  WorkflowStepEvidence,
  type WorkflowWire,
} from '@podium/protocol'
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  max,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'
import {
  workflowBindings,
  workflowEvents,
  workflowRevisions,
  workflowRunSteps,
  workflowRuns,
  workflows as workflowsTable,
} from '../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { param, prepared, preparedFamily } from './executor/sync-drizzle'

/**
 * DISCRIMINATED (POD-362), was `{ kind: 'operator' | 'session'; id: string | null }`.
 * Every producer already obeys the correlation — router.ts emits
 * `{ kind: 'operator', id: null }` and the three session producers emit a real
 * session id — but the old shape let `{ kind: 'operator', id: <something> }` be
 * built, so `id` could not carry `SessionId` without lying on the operator arm.
 * As a union the brand is exact and the illegal pair is unrepresentable.
 */
export type WorkflowActor = { kind: 'operator'; id: null } | { kind: 'session'; id: SessionId }

/** The run history's keyset cursor: the last row of the previous page. */
export interface WorkflowRunCursor {
  startedAt: string
  id: string
}

/** Sorts after every stored `started_at` (an ISO timestamp), so the first page
 *  holds the newest runs. */
const RUN_HISTORY_START: WorkflowRunCursor = { startedAt: '\uffff', id: '' }

export interface WorkflowRunRow {
  id: string
  subjectKind: 'issue' | 'session'
  subjectId: string
  coordinatorSessionId: SessionId
  revisionId: string
  status: WorkflowRunStatus
  supersedesRunId: string | null
  startedAt: string
  completedAt: string | null
  ownerUserId: UserId
}

function required<T>(value: T | null, message: string): T {
  if (value === null) throw new Error(message)
  return value
}

/**
 * A JSON text column, parsed for the schema that validates it.
 *
 * KEPT, and it is a rule 6 DECISION rather than a driver artefact. None of this
 * file's JSON columns is `mode: 'json'` (checked against `schema.ts`: the only
 * five in the tree are shipping's), so drizzle hands back the string and this is
 * where it becomes a value. The `fallback` swallows a PARSE error and the zod
 * `.parse()` at each call site then refuses a wrong SHAPE — two different
 * failures with two different answers, which is the behaviour the corrupt-blob
 * oracle pinned and the conversion preserves exactly.
 */
function parseJson<T>(raw: unknown, fallback: T): unknown {
  if (typeof raw !== 'string') return fallback
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return fallback
  }
}

/** `w.*` plus the derived latest version, the shape both workflow reads share. */
type WorkflowSelection = typeof workflowsTable.$inferSelect & { latestVersion: number }

/**
 * `COALESCE((SELECT MAX(version) …), 0)` — the derived column both workflow
 * reads project. A workflow with no revisions is 0, never null.
 *
 * THE OUTER COLUMN IS QUALIFIED BY HAND, and it has to be. drizzle does not
 * table-qualify a column interpolated into a `sql` fragment when the enclosing
 * query has a single FROM table, so `${workflowsTable.id}` emits a bare `"id"` —
 * which, inside this subquery, resolves to `workflow_revisions.id` rather than
 * to the outer row. The correlation then reads
 * `workflow_revisions.workflow_id = workflow_revisions.id`, matches nothing, and
 * every workflow reports latestVersion 0. It throws nothing and logs nothing;
 * store/workflows-golden.test.ts is what caught it.
 */
const latestVersionOf = sql<number>`COALESCE((SELECT MAX(${workflowRevisions.version}) FROM ${workflowRevisions} WHERE ${workflowRevisions.workflowId} = ${sql.identifier('workflows')}.${sql.identifier('id')}), 0)`

const workflowSelection = {
  ...getTableColumns(workflowsTable),
  latestVersion: latestVersionOf,
}

function toWorkflow(row: WorkflowSelection): WorkflowWire {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope as WorkflowScope,
    scopeRef: row.scopeRef,
    latestRevisionId: row.latestRevisionId,
    latestVersion: Number(row.latestVersion ?? 0),
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toRevision(row: typeof workflowRevisions.$inferSelect): WorkflowRevisionWire {
  return {
    id: row.id,
    workflowId: row.workflowId,
    version: row.version,
    instructions: row.instructions,
    steps: WorkflowStep.array().parse(parseJson(row.stepsJson, [])),
    createdAt: row.createdAt,
    publishedAt: row.publishedAt,
  }
}

function toBinding(row: typeof workflowBindings.$inferSelect): WorkflowBindingWire {
  return {
    targetKind: row.targetKind as WorkflowBindingTarget,
    targetId: row.targetId,
    revisionId: row.revisionId,
    updatedAt: row.updatedAt,
  }
}

function toRun(row: typeof workflowRuns.$inferSelect): WorkflowRunRow {
  return {
    id: row.id,
    subjectKind: row.subjectKind as 'issue' | 'session',
    subjectId: row.subjectId,
    coordinatorSessionId: row.coordinatorSessionId,
    revisionId: row.revisionId,
    status: row.status as WorkflowRunStatus,
    supersedesRunId: row.supersedesRunId,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    ownerUserId: row.ownerUserId,
  }
}

function toRunStep(row: typeof workflowRunSteps.$inferSelect): RunStep {
  // A snapshot this build cannot read degrades to "unavailable", never a throw:
  // the run's other steps stay readable.
  const snapshot = AgentProfileWire.safeParse(parseJson(row.agentProfileJson, null))
  return WorkflowRunStepWire.parse({
    stepId: row.stepId,
    position: row.position,
    title: row.title,
    instructions: row.instructions,
    completionGuidance: row.completionGuidance,
    agentProfileId: row.agentProfileId ?? null,
    agentProfileSnapshot: snapshot.success ? snapshot.data : null,
    status: row.status,
    assignedSessionId: row.assignedSessionId ?? null,
    attempt: row.attempt,
    summary: row.summary,
    evidence: WorkflowStepEvidence.parse(parseJson(row.evidenceJson, {})),
    observation:
      row.observationJson == null
        ? null
        : WorkflowGitObservation.parse(parseJson(row.observationJson, null)),
    warnings: parseJson(row.warningsJson, []),
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
  })
}

// Every query this repository runs, prepared once per store [POD-6147].

const P = (name: string) => sql.placeholder(name)

const workflowOwner = prepared((db: StoreDrizzle) =>
  db
    .select({ ownerUserId: workflowsTable.ownerUserId })
    .from(workflowsTable)
    .where(eq(workflowsTable.id, param(workflowsTable.id, 'id')))
    .prepare(),
)

const revisionOwner = prepared((db: StoreDrizzle) =>
  db
    .select({ ownerUserId: workflowsTable.ownerUserId })
    .from(workflowRevisions)
    .innerJoin(workflowsTable, eq(workflowsTable.id, workflowRevisions.workflowId))
    .where(eq(workflowRevisions.id, param(workflowRevisions.id, 'id')))
    .prepare(),
)

const bindingIs = () =>
  and(
    eq(workflowBindings.targetKind, param(workflowBindings.targetKind, 'targetKind')),
    eq(workflowBindings.targetId, param(workflowBindings.targetId, 'targetId')),
  )

const bindingOwner = prepared((db: StoreDrizzle) =>
  db.select({ ownerUserId: workflowBindings.ownerUserId }).from(workflowBindings).where(bindingIs()).prepare(),
)

const runOwner = prepared((db: StoreDrizzle) =>
  db
    .select({ ownerUserId: workflowRuns.ownerUserId })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, param(workflowRuns.id, 'id')))
    .prepare(),
)

/** Keyed by which of the three optional filters are set, e.g. `a1|s0|r1`. */
const workflowsWhere = preparedFamily((db: StoreDrizzle, key: string) => {
  const [archived, scope, scopeRef] = key.split('|')
  const clauses: SQL[] = []
  if (archived === 'a0') clauses.push(isNull(workflowsTable.archivedAt))
  if (scope === 's1') clauses.push(eq(workflowsTable.scope, param(workflowsTable.scope, 'scope')))
  if (scopeRef === 'r1') {
    clauses.push(eq(workflowsTable.scopeRef, param(workflowsTable.scopeRef, 'scopeRef')))
  }
  return db
    .select(workflowSelection)
    .from(workflowsTable)
    .where(clauses.length ? and(...clauses) : undefined)
    // COLLATE NOCASE: with a binary collation 'Zebra' would sort before 'apple'.
    .orderBy(sql`${workflowsTable.name} COLLATE NOCASE`, asc(workflowsTable.createdAt))
    .prepare()
})

const workflowById = prepared((db: StoreDrizzle) =>
  db.select(workflowSelection).from(workflowsTable).where(eq(workflowsTable.id, param(workflowsTable.id, 'id'))).prepare(),
)

const insertWorkflowRow = prepared((db: StoreDrizzle) =>
  db
    .insert(workflowsTable)
    .values({
      id: P('id'),
      name: P('name'),
      description: P('description'),
      scope: P('scope'),
      scopeRef: P('scopeRef'),
      createdByKind: P('createdByKind'),
      createdById: P('createdById'),
      ownerUserId: P('ownerUserId'),
      createdAt: P('now'),
      updatedAt: P('now'),
    })
    .prepare(),
)

const revisionsOf = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(workflowRevisions)
    .where(eq(workflowRevisions.workflowId, param(workflowRevisions.workflowId, 'workflowId')))
    .orderBy(desc(workflowRevisions.version))
    .prepare(),
)

const revisionById = prepared((db: StoreDrizzle) =>
  db.select().from(workflowRevisions).where(eq(workflowRevisions.id, param(workflowRevisions.id, 'id'))).prepare(),
)

const latestRevisionVersion = prepared((db: StoreDrizzle) =>
  db
    .select({ version: max(workflowRevisions.version) })
    .from(workflowRevisions)
    .where(eq(workflowRevisions.workflowId, param(workflowRevisions.workflowId, 'workflowId')))
    .prepare(),
)

const insertRevisionRow = prepared((db: StoreDrizzle) =>
  db
    .insert(workflowRevisions)
    .values({
      id: P('id'),
      workflowId: P('workflowId'),
      version: P('version'),
      instructions: P('instructions'),
      stepsJson: P('stepsJson'),
      createdByKind: P('createdByKind'),
      createdById: P('createdById'),
      createdAt: P('now'),
    })
    .prepare(),
)

const setLatestRevision = prepared((db: StoreDrizzle) =>
  db
    .update(workflowsTable)
    .set({ latestRevisionId: P('revisionId'), updatedAt: P('now') })
    .where(eq(workflowsTable.id, param(workflowsTable.id, 'workflowId')))
    .prepare(),
)

const publishRevisionRow = prepared((db: StoreDrizzle) =>
  db
    .update(workflowRevisions)
    // COALESCE: a published revision has ONE publication moment, so a repeat
    // must not re-date it.
    .set({ publishedAt: sql`COALESCE(${workflowRevisions.publishedAt}, ${P('now')})` })
    .where(eq(workflowRevisions.id, param(workflowRevisions.id, 'revisionId')))
    .prepare(),
)

const bindingOf = prepared((db: StoreDrizzle) =>
  db.select().from(workflowBindings).where(bindingIs()).prepare(),
)

const allBindings = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(workflowBindings)
    .orderBy(asc(workflowBindings.targetKind), asc(workflowBindings.targetId))
    .prepare(),
)

const upsertBinding = prepared((db: StoreDrizzle) =>
  db
    .insert(workflowBindings)
    .values({
      targetKind: P('targetKind'),
      targetId: P('targetId'),
      revisionId: P('revisionId'),
      updatedByKind: P('updatedByKind'),
      updatedById: P('updatedById'),
      ownerUserId: P('ownerUserId'),
      updatedAt: P('now'),
    })
    .onConflictDoUpdate({
      target: [workflowBindings.targetKind, workflowBindings.targetId],
      // FOUR COLUMNS, and `owner_user_id` is deliberately not among them: a
      // rebind may not change the resource owner `ownerOf` authorizes from.
      set: {
        revisionId: P('revisionId'),
        updatedByKind: P('updatedByKind'),
        updatedById: P('updatedById'),
        updatedAt: P('now'),
      },
    })
    .prepare(),
)

/** One keyset page of the run history, newest first, through
 *  `workflow_runs_started` (POD-6209): the runs before the cursor's
 *  `(started_at, id)`. The first page starts before {@link RUN_HISTORY_START}. */
const runsPage = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(workflowRuns)
    .where(
      sql`(${workflowRuns.startedAt}, ${workflowRuns.id}) < (${param(workflowRuns.startedAt, 'beforeStartedAt')}, ${param(workflowRuns.id, 'beforeId')})`,
    )
    .orderBy(desc(workflowRuns.startedAt), desc(workflowRuns.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

const liveRuns = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(workflowRuns)
    .where(inArray(workflowRuns.status, ['active', 'blocked']))
    .orderBy(desc(workflowRuns.startedAt))
    .prepare(),
)

const runById = prepared((db: StoreDrizzle) =>
  db.select().from(workflowRuns).where(eq(workflowRuns.id, param(workflowRuns.id, 'id'))).prepare(),
)

const stepsOfRun = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(workflowRunSteps)
    .where(eq(workflowRunSteps.runId, param(workflowRunSteps.runId, 'runId')))
    .orderBy(asc(workflowRunSteps.position))
    .prepare(),
)

// THE NARROW PROJECTION IS THE POINT (see `listRunEvents`).
const eventsOfRun = prepared((db: StoreDrizzle) =>
  db
    .select({
      kind: workflowEvents.kind,
      actorKind: workflowEvents.actorKind,
      actorId: workflowEvents.actorId,
      onBehalfOf: workflowEvents.onBehalfOf,
      createdAt: workflowEvents.createdAt,
    })
    .from(workflowEvents)
    .where(eq(workflowEvents.runId, param(workflowEvents.runId, 'runId')))
    .orderBy(asc(workflowEvents.id))
    .prepare(),
)

const liveRunOfSubject = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.subjectKind, param(workflowRuns.subjectKind, 'subjectKind')),
        eq(workflowRuns.subjectId, param(workflowRuns.subjectId, 'subjectId')),
        inArray(workflowRuns.status, ['active', 'blocked']),
      ),
    )
    .orderBy(desc(workflowRuns.startedAt))
    .limit(1)
    .prepare(),
)

const liveRunOfSession = prepared((db: StoreDrizzle) =>
  db
    .selectDistinct(getTableColumns(workflowRuns))
    .from(workflowRuns)
    .leftJoin(workflowRunSteps, eq(workflowRunSteps.runId, workflowRuns.id))
    .where(
      and(
        inArray(workflowRuns.status, ['active', 'blocked']),
        or(
          eq(workflowRuns.coordinatorSessionId, param(workflowRuns.coordinatorSessionId, 'sessionId')),
          eq(workflowRunSteps.assignedSessionId, param(workflowRunSteps.assignedSessionId, 'sessionId')),
        ),
      ),
    )
    .orderBy(desc(workflowRuns.startedAt))
    .limit(1)
    .prepare(),
)

const insertRunRow = prepared((db: StoreDrizzle) =>
  db
    .insert(workflowRuns)
    .values({
      id: P('id'),
      subjectKind: P('subjectKind'),
      subjectId: P('subjectId'),
      coordinatorSessionId: P('coordinatorSessionId'),
      revisionId: P('revisionId'),
      status: P('status'),
      supersedesRunId: P('supersedesRunId'),
      startedAt: P('startedAt'),
      completedAt: P('completedAt'),
      ownerUserId: P('ownerUserId'),
    })
    .prepare(),
)

/**
 * One multi-row insert per step COUNT, as the fluent form built: a run's steps
 * are its workflow's, so the count comes from a small domain (the family's
 * backstop bounds it regardless).
 */
const insertRunSteps = preparedFamily((db: StoreDrizzle, count: number) =>
  db
    .insert(workflowRunSteps)
    .values(
      Array.from({ length: count }, (_, i) => ({
        runId: P('runId'),
        stepId: P(`stepId${i}`),
        position: P(`position${i}`),
        title: P(`title${i}`),
        instructions: P(`instructions${i}`),
        completionGuidance: P(`completionGuidance${i}`),
        agentProfileId: P(`agentProfileId${i}`),
        agentProfileJson: P(`agentProfileJson${i}`),
        // The two literals the raw INSERT carried, kept explicit rather than
        // left to the column defaults, which is what it did.
        status: 'pending' as const,
        evidenceJson: '{}',
      })),
    )
    .prepare(),
)

const setRunStatus = prepared((db: StoreDrizzle) =>
  db
    .update(workflowRuns)
    .set({ status: P('status'), completedAt: P('completedAt') })
    .where(eq(workflowRuns.id, param(workflowRuns.id, 'id')))
    .prepare(),
)

const stepIs = () =>
  and(
    eq(workflowRunSteps.runId, param(workflowRunSteps.runId, 'runId')),
    eq(workflowRunSteps.stepId, param(workflowRunSteps.stepId, 'stepId')),
  )

const updateStepRow = prepared((db: StoreDrizzle) =>
  db
    .update(workflowRunSteps)
    .set({
      status: P('status'),
      assignedSessionId: P('assignedSessionId'),
      summary: P('summary'),
      evidenceJson: P('evidenceJson'),
      observationJson: P('observationJson'),
      warningsJson: P('warningsJson'),
      startedAt: P('startedAt'),
      completedAt: P('completedAt'),
    })
    .where(stepIs())
    .prepare(),
)

const assignStepRow = prepared((db: StoreDrizzle) =>
  db.update(workflowRunSteps).set({ assignedSessionId: P('sessionId') }).where(stepIs()).prepare(),
)

const resetStepRow = prepared((db: StoreDrizzle) =>
  db
    .update(workflowRunSteps)
    .set({
      status: 'pending',
      // READ-MODIFY-WRITE IN SQL. Binding a computed value would need a prior
      // read and would be a different statement with a different race.
      attempt: sql`${workflowRunSteps.attempt} + 1`,
      summary: '',
      evidenceJson: '{}',
      observationJson: null,
      warningsJson: '[]',
      startedAt: null,
      completedAt: null,
    })
    .where(stepIs())
    .prepare(),
)

const appendEventRow = prepared((db: StoreDrizzle) =>
  db
    .insert(workflowEvents)
    .values({
      workflowId: P('workflowId'),
      runId: P('runId'),
      kind: P('kind'),
      actorKind: P('actorKind'),
      actorId: P('actorId'),
      onBehalfOf: P('onBehalfOf'),
      payloadJson: P('payloadJson'),
      createdAt: P('now'),
    })
    .prepare(),
)

export class WorkflowsRepository {
  /**
   * The capability is WIRING and is named here and nowhere else [spec rule 34].
   * A call site reads `this.db.select(…)` and `await this.createOrJoinTransaction(…)`.
   */
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * A GETTER, NOT A FIELD [spec rule 34a]. A field assigned in the constructor
   * freezes `db` to the ROOT instance, and rule 35 routes transactions
   * ambiently — `db` has to resolve the ENCLOSING transaction on every access.
   * B1 changes this one line, here, instead of turning 39 fields into getters.
   */
  protected get db(): StoreDrizzle {
    return this.rootDb
  }

  async ownerOf(kind: string, id: string): Promise<string | null> {
    let row: { ownerUserId?: UserId | null } | undefined
    if (kind === 'workflow-definition' || kind === 'workflow-library-entry') {
      row = await workflowOwner(this.db).get({ id })
    } else if (kind === 'workflow-revision') {
      row = await revisionOwner(this.db).get({ id })
    } else if (kind === 'workflow-binding') {
      const split = id.indexOf(':')
      if (split < 0) return null
      row = await bindingOwner(this.db).get({
        targetKind: id.slice(0, split),
        targetId: id.slice(split + 1),
      })
    } else if (kind === 'workflow-run') {
      row = await runOwner(this.db).get({ id })
    }
    return typeof row?.ownerUserId === 'string' ? row.ownerUserId : null
  }

  async listWorkflows(
    opts: { includeArchived?: boolean; scope?: WorkflowScope; scopeRef?: string } = {},
  ): Promise<WorkflowWire[]> {
    // `!== undefined`, not truthiness: an explicit scopeRef of null binds null
    // and therefore matches nothing, which is what this has always done. See the
    // pin in store/workflows-golden.test.ts.
    const key = [
      opts.includeArchived ? 'a1' : 'a0',
      opts.scope ? 's1' : 's0',
      opts.scopeRef !== undefined ? 'r1' : 'r0',
    ].join('|')
    return (
      await workflowsWhere(this.db, key).all({ scope: opts.scope, scopeRef: opts.scopeRef })
    ).map(toWorkflow)
  }

  async getWorkflow(id: string): Promise<WorkflowWire | null> {
    const row = await workflowById(this.db).get({ id })
    return row ? toWorkflow(row) : null
  }

  async insertWorkflow(row: {
    id: string
    name: string
    description: string
    scope: WorkflowScope
    scopeRef: string | null
    actor: WorkflowActor
    ownerUserId: UserId
    now: string
  }): Promise<void> {
    await insertWorkflowRow(this.db).run({
      id: row.id,
      name: row.name,
      description: row.description,
      scope: row.scope,
      scopeRef: row.scopeRef,
      createdByKind: row.actor.kind,
      createdById: row.actor.id,
      ownerUserId: row.ownerUserId,
      now: row.now,
    })
  }

  async listRevisions(workflowId: string): Promise<WorkflowRevisionWire[]> {
    return (await revisionsOf(this.db).all({ workflowId })).map(toRevision)
  }

  async getRevision(id: string): Promise<WorkflowRevisionWire | null> {
    const row = await revisionById(this.db).get({ id })
    return row ? toRevision(row) : null
  }

  async insertRevision(row: {
    id: string
    workflowId: string
    instructions: string
    steps: Step[]
    actor: WorkflowActor
    now: string
  }): Promise<WorkflowRevisionWire> {
    // READ-DECIDE-WRITE. The version is allocated from MAX(version)+1 and then
    // inserted at, so the span is the allocation's atomicity and not decoration.
    return await this.createOrJoinTransaction(async () => {
      const next = await latestRevisionVersion(this.db).get({ workflowId: row.workflowId })
      await insertRevisionRow(this.db).run({
        id: row.id,
        workflowId: row.workflowId,
        version: Number(next?.version ?? 0) + 1,
        instructions: row.instructions,
        stepsJson: JSON.stringify(row.steps),
        createdByKind: row.actor.kind,
        createdById: row.actor.id,
        now: row.now,
      })
      await setLatestRevision(this.db).run({
        revisionId: row.id,
        now: row.now,
        workflowId: row.workflowId,
      })
      return required(await this.getRevision(row.id), `workflow revision ${row.id} was not persisted`)
    })
  }

  async publishRevision(revisionId: string, now: string): Promise<void> {
    await publishRevisionRow(this.db).run({ revisionId, now })
  }

  async getBinding(targetKind: WorkflowBindingTarget, targetId: string): Promise<WorkflowBindingWire | null> {
    const row = await bindingOf(this.db).get({ targetKind, targetId })
    return row ? toBinding(row) : null
  }

  async listBindings(): Promise<WorkflowBindingWire[]> {
    return (await allBindings(this.db).all()).map(toBinding)
  }

  async setBinding(input: {
    targetKind: WorkflowBindingTarget
    targetId: string
    revisionId: string
    actor: WorkflowActor
    ownerUserId: UserId
    now: string
  }): Promise<WorkflowBindingWire> {
    await upsertBinding(this.db).run({
      targetKind: input.targetKind,
      targetId: input.targetId,
      revisionId: input.revisionId,
      updatedByKind: input.actor.kind,
      updatedById: input.actor.id,
      ownerUserId: input.ownerUserId,
      now: input.now,
    })
    return required(
      await this.getBinding(input.targetKind, input.targetId),
      `workflow binding ${input.targetKind}:${input.targetId} was not persisted`,
    )
  }

  /** The live runs (active or blocked), newest first. */
  async listRuns(): Promise<WorkflowRunRow[]> {
    return (await liveRuns(this.db).all()).map(toRun)
  }

  /** One keyset page of every run, live and terminal, newest first (POD-6209).
   *  The cursor is the last row of the previous page. */
  async listRunsPage(opts: { before?: WorkflowRunCursor; limit: number }): Promise<WorkflowRunRow[]> {
    const before = opts.before ?? RUN_HISTORY_START
    const rows = await runsPage(this.db).all({
      beforeStartedAt: before.startedAt,
      beforeId: before.id,
      limit: Math.max(1, Math.trunc(opts.limit)),
    })
    return rows.map(toRun)
  }

  async getRun(id: string): Promise<WorkflowRunRow | null> {
    const row = await runById(this.db).get({ id })
    return row ? toRun(row) : null
  }

  async getRunSteps(runId: string): Promise<RunStep[]> {
    return (await stepsOfRun(this.db).all({ runId })).map(toRunStep)
  }

  /**
   * The run's recorded acts, oldest first — the read side of `appendEvent`.
   *
   * Projects the ATTRIBUTION PAIR (`actor_kind`/`actor_id` and `on_behalf_of`)
   * and nothing else: `payload_json` is written through each contract's own
   * redaction policy and has no business widening a read model that exists to
   * answer "who did this, for whom". Ordered by `id` — the insertion order — and
   * served by the `workflow_events_run` index, which is already on
   * `(run_id, id)`.
   *
   * THE NARROW PROJECTION IS THE POINT and a `select()` with no argument here
   * would be a redaction change, not a simplification (spec §6 rule 4 names this
   * column as having no store reader by design).
   */
  async listRunEvents(runId: string): Promise<WorkflowRunEventWire[]> {
    return (await eventsOfRun(this.db).all({ runId }))
      .map((row) => ({
        kind: row.kind,
        actorKind: row.actorKind,
        // NEVER substituted. A null actor id is a row whose actor predates the
        // column; inventing one would be a lie in an audit trail.
        actorId: row.actorId,
        onBehalfOf: row.onBehalfOf,
        createdAt: row.createdAt,
      }))
  }

  async findLiveRun(subjectKind: 'issue' | 'session', subjectId: string): Promise<WorkflowRunRow | null> {
    const row = await liveRunOfSubject(this.db).get({ subjectKind, subjectId })
    return row ? toRun(row) : null
  }

  async findLiveRunForSession(sessionId: SessionId): Promise<WorkflowRunRow | null> {
    const row = await liveRunOfSession(this.db).get({ sessionId })
    return row ? toRun(row) : null
  }

  async insertRun(input: {
    run: WorkflowRunRow
    steps: Array<Step & { profileId: string | null; profile: AgentProfileWire | null }>
  }): Promise<void> {
    await this.createOrJoinTransaction(async () => {
      await insertRunRow(this.db).run({
        id: input.run.id,
        subjectKind: input.run.subjectKind,
        subjectId: input.run.subjectId,
        coordinatorSessionId: input.run.coordinatorSessionId,
        revisionId: input.run.revisionId,
        status: input.run.status,
        supersedesRunId: input.run.supersedesRunId,
        startedAt: input.run.startedAt,
        completedAt: input.run.completedAt,
        ownerUserId: input.run.ownerUserId,
      })
      // No steps means NO statement, as the `forEach` this replaces did.
      if (input.steps.length === 0) return
      const stepValues: Record<string, unknown> = { runId: input.run.id }
      input.steps.forEach((step, position) => {
        stepValues[`stepId${position}`] = step.id
        stepValues[`position${position}`] = position
        stepValues[`title${position}`] = step.title
        stepValues[`instructions${position}`] = step.instructions
        stepValues[`completionGuidance${position}`] = step.completionGuidance
        stepValues[`agentProfileId${position}`] = step.profileId
        stepValues[`agentProfileJson${position}`] = step.profile ? JSON.stringify(step.profile) : null
      })
      await insertRunSteps(this.db, input.steps.length).run(stepValues)
    })
  }

  async updateRunStatus(id: string, status: WorkflowRunStatus, completedAt: string | null): Promise<void> {
    await setRunStatus(this.db).run({ id, status, completedAt })
  }

  async updateStep(input: {
    runId: string
    stepId: string
    status: WorkflowRunStepStatus
    assignedSessionId: SessionId | null
    summary: string
    evidence: StepEvidence
    observation: GitObservation | null
    warnings: string[]
    startedAt: string | null
    completedAt: string | null
  }): Promise<void> {
    await updateStepRow(this.db).run({
      runId: input.runId,
      stepId: input.stepId,
      status: input.status,
      assignedSessionId: input.assignedSessionId,
      summary: input.summary,
      evidenceJson: JSON.stringify(input.evidence),
      observationJson: input.observation ? JSON.stringify(input.observation) : null,
      warningsJson: JSON.stringify(input.warnings),
      startedAt: input.startedAt,
      completedAt: input.completedAt,
    })
  }

  async assignStep(runId: string, stepId: string, sessionId: SessionId | null): Promise<void> {
    await assignStepRow(this.db).run({ runId, stepId, sessionId })
  }

  async resetStep(runId: string, stepId: string): Promise<void> {
    await resetStepRow(this.db).run({ runId, stepId })
  }

  /**
   * The append-only run history — and the ONLY durable audit trail this surface
   * has (POD-730 §9: there is no reader in the product, and these appends must
   * not be dropped on the assumption nothing reads them).
   *
   * `actor` is WHICH agent or session acted; `onBehalfOf` is WHICH HUMAN it
   * acted for — ADR 9 D5 A3's pair, not a substitution. Both come from the
   * transport principal; neither is reachable from payload.
   */
  async appendEvent(input: {
    workflowId?: string | null
    runId?: string | null
    kind: string
    actor: WorkflowActor
    /** The delegating human. `null`/absent = a system principal, or a row from
     *  before the column existed — never "the operator" by default. */
    onBehalfOf?: string | null
    payload?: Record<string, unknown>
    now: string
  }): Promise<void> {
    await appendEventRow(this.db).run({
      workflowId: input.workflowId ?? null,
      runId: input.runId ?? null,
      kind: input.kind,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      onBehalfOf: input.onBehalfOf ?? null,
      payloadJson: JSON.stringify(input.payload ?? {}),
      now: input.now,
    })
  }
}
