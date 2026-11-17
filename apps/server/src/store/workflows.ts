// workspace-scoped (POD-6959)
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
import type {
  workflowBindings,
  workflowRevisions,
  workflowRunSteps,
  workflowRuns,
  workflows as workflowsTable,
} from '../migrations/schema'
import type {
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
 *
 * The subquery holds its revisions to the workspace in its own scope (POD-6959).
 */
const latestVersionOf = (t: StoreTables) =>
  sql<number>`COALESCE((SELECT MAX(${t.workflowRevisions.version}) FROM ${t.workflowRevisions} WHERE ${t.workflowRevisions.workspaceId} = ${WORKSPACE} AND ${t.workflowRevisions.workflowId} = ${sql.identifier('workflows')}.${sql.identifier('id')}), 0)`

const workflowSelection = (t: StoreTables) => ({
  ...getTableColumns(t.workflows),
  latestVersion: latestVersionOf(t),
})

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

const workflowOwner = prepared((db, t) =>
  db
    .select({ ownerUserId: t.workflows.ownerUserId })
    .from(t.workflows)
    .where(inWorkspace(t.workflows, eq(t.workflows.id, param(t.workflows.id, 'id'))))
    .prepare(),
)

const revisionOwner = prepared((db, t) =>
  db
    .select({ ownerUserId: t.workflows.ownerUserId })
    .from(t.workflowRevisions)
    .innerJoin(
      t.workflows,
      and(
        sameWorkspace(t.workflows, t.workflowRevisions),
        eq(t.workflows.id, t.workflowRevisions.workflowId),
      ),
    )
    .where(
      inWorkspace(
        t.workflowRevisions,
        eq(t.workflowRevisions.id, param(t.workflowRevisions.id, 'id')),
      ),
    )
    .prepare(),
)

const bindingIs = (t: StoreTables) =>
  and(
    eq(t.workflowBindings.targetKind, param(t.workflowBindings.targetKind, 'targetKind')),
    eq(t.workflowBindings.targetId, param(t.workflowBindings.targetId, 'targetId')),
  )

const bindingOwner = prepared((db, t) =>
  db
    .select({ ownerUserId: t.workflowBindings.ownerUserId })
    .from(t.workflowBindings)
    .where(inWorkspace(t.workflowBindings, bindingIs(t)))
    .prepare(),
)

const runOwner = prepared((db, t) =>
  db
    .select({ ownerUserId: t.workflowRuns.ownerUserId })
    .from(t.workflowRuns)
    .where(inWorkspace(t.workflowRuns, eq(t.workflowRuns.id, param(t.workflowRuns.id, 'id'))))
    .prepare(),
)

/** Keyed by which of the three optional filters are set, e.g. `a1|s0|r1`. */
const workflowsWhere = preparedFamily((db, t, key: string) => {
  const [archived, scope, scopeRef] = key.split('|')
  const clauses: SQL[] = []
  if (archived === 'a0') clauses.push(isNull(t.workflows.archivedAt))
  if (scope === 's1') clauses.push(eq(t.workflows.scope, param(t.workflows.scope, 'scope')))
  if (scopeRef === 'r1') {
    clauses.push(eq(t.workflows.scopeRef, param(t.workflows.scopeRef, 'scopeRef')))
  }
  return (
    db
      .select(workflowSelection(t))
      .from(t.workflows)
      .where(inWorkspace(t.workflows, clauses.length ? and(...clauses) : undefined))
      // COLLATE NOCASE: with a binary collation 'Zebra' would sort before 'apple'.
      .orderBy(sql`${t.workflows.name} COLLATE NOCASE`, asc(t.workflows.createdAt))
      .prepare()
  )
})

const workflowById = prepared((db, t) =>
  db
    .select(workflowSelection(t))
    .from(t.workflows)
    .where(inWorkspace(t.workflows, eq(t.workflows.id, param(t.workflows.id, 'id'))))
    .prepare(),
)

const insertWorkflowRow = prepared((db, t) =>
  db
    .insert(t.workflows)
    .values({
      workspaceId: WORKSPACE,
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

const revisionsOf = prepared((db, t) =>
  db
    .select()
    .from(t.workflowRevisions)
    .where(
      inWorkspace(
        t.workflowRevisions,
        eq(t.workflowRevisions.workflowId, param(t.workflowRevisions.workflowId, 'workflowId')),
      ),
    )
    .orderBy(desc(t.workflowRevisions.version))
    .prepare(),
)

const revisionById = prepared((db, t) =>
  db
    .select()
    .from(t.workflowRevisions)
    .where(
      inWorkspace(
        t.workflowRevisions,
        eq(t.workflowRevisions.id, param(t.workflowRevisions.id, 'id')),
      ),
    )
    .prepare(),
)

const latestRevisionVersion = prepared((db, t) =>
  db
    .select({ version: max(t.workflowRevisions.version) })
    .from(t.workflowRevisions)
    .where(
      inWorkspace(
        t.workflowRevisions,
        eq(t.workflowRevisions.workflowId, param(t.workflowRevisions.workflowId, 'workflowId')),
      ),
    )
    .prepare(),
)

const insertRevisionRow = prepared((db, t) =>
  db
    .insert(t.workflowRevisions)
    .values({
      workspaceId: WORKSPACE,
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

const setLatestRevision = prepared((db, t) =>
  db
    .update(t.workflows)
    .set({ latestRevisionId: P('revisionId'), updatedAt: P('now') })
    .where(inWorkspace(t.workflows, eq(t.workflows.id, param(t.workflows.id, 'workflowId'))))
    .prepare(),
)

const publishRevisionRow = prepared((db, t) =>
  db
    .update(t.workflowRevisions)
    // COALESCE: a published revision has ONE publication moment, so a repeat
    // must not re-date it.
    .set({ publishedAt: sql`COALESCE(${t.workflowRevisions.publishedAt}, ${P('now')})` })
    .where(
      inWorkspace(
        t.workflowRevisions,
        eq(t.workflowRevisions.id, param(t.workflowRevisions.id, 'revisionId')),
      ),
    )
    .prepare(),
)

const bindingOf = prepared((db, t) =>
  db
    .select()
    .from(t.workflowBindings)
    .where(inWorkspace(t.workflowBindings, bindingIs(t)))
    .prepare(),
)

const allBindings = prepared((db, t) =>
  db
    .select()
    .from(t.workflowBindings)
    .where(inWorkspace(t.workflowBindings))
    .orderBy(asc(t.workflowBindings.targetKind), asc(t.workflowBindings.targetId))
    .prepare(),
)

const upsertBinding = prepared((db, t) =>
  db
    .insert(t.workflowBindings)
    .values({
      workspaceId: WORKSPACE,
      targetKind: P('targetKind'),
      targetId: P('targetId'),
      revisionId: P('revisionId'),
      updatedByKind: P('updatedByKind'),
      updatedById: P('updatedById'),
      ownerUserId: P('ownerUserId'),
      updatedAt: P('now'),
    })
    .onConflictDoUpdate({
      target: [t.workflowBindings.targetKind, t.workflowBindings.targetId],
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
const runsPage = prepared((db, t) =>
  db
    .select()
    .from(t.workflowRuns)
    .where(
      inWorkspace(
        t.workflowRuns,
        sql`(${t.workflowRuns.startedAt}, ${t.workflowRuns.id}) < (${param(t.workflowRuns.startedAt, 'beforeStartedAt')}, ${param(t.workflowRuns.id, 'beforeId')})`,
      ),
    )
    .orderBy(desc(t.workflowRuns.startedAt), desc(t.workflowRuns.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

const liveRuns = prepared((db, t) =>
  db
    .select()
    .from(t.workflowRuns)
    .where(inWorkspace(t.workflowRuns, inArray(t.workflowRuns.status, ['active', 'blocked'])))
    .orderBy(desc(t.workflowRuns.startedAt))
    .prepare(),
)

const runById = prepared((db, t) =>
  db
    .select()
    .from(t.workflowRuns)
    .where(inWorkspace(t.workflowRuns, eq(t.workflowRuns.id, param(t.workflowRuns.id, 'id'))))
    .prepare(),
)

const stepsOfRun = prepared((db, t) =>
  db
    .select()
    .from(t.workflowRunSteps)
    .where(
      inWorkspace(
        t.workflowRunSteps,
        eq(t.workflowRunSteps.runId, param(t.workflowRunSteps.runId, 'runId')),
      ),
    )
    .orderBy(asc(t.workflowRunSteps.position))
    .prepare(),
)

// THE NARROW PROJECTION IS THE POINT (see `listRunEvents`).
const eventsOfRun = prepared((db, t) =>
  db
    .select({
      kind: t.workflowEvents.kind,
      actorKind: t.workflowEvents.actorKind,
      actorId: t.workflowEvents.actorId,
      onBehalfOf: t.workflowEvents.onBehalfOf,
      createdAt: t.workflowEvents.createdAt,
    })
    .from(t.workflowEvents)
    .where(
      inWorkspace(
        t.workflowEvents,
        eq(t.workflowEvents.runId, param(t.workflowEvents.runId, 'runId')),
      ),
    )
    .orderBy(asc(t.workflowEvents.id))
    .prepare(),
)

const liveRunOfSubject = prepared((db, t) =>
  db
    .select()
    .from(t.workflowRuns)
    .where(
      inWorkspace(
        t.workflowRuns,
        eq(t.workflowRuns.subjectKind, param(t.workflowRuns.subjectKind, 'subjectKind')),
        eq(t.workflowRuns.subjectId, param(t.workflowRuns.subjectId, 'subjectId')),
        inArray(t.workflowRuns.status, ['active', 'blocked']),
      ),
    )
    .orderBy(desc(t.workflowRuns.startedAt))
    .limit(1)
    .prepare(),
)

const liveRunOfSession = prepared((db, t) =>
  db
    .selectDistinct(getTableColumns(t.workflowRuns))
    .from(t.workflowRuns)
    .leftJoin(
      t.workflowRunSteps,
      and(
        sameWorkspace(t.workflowRunSteps, t.workflowRuns),
        eq(t.workflowRunSteps.runId, t.workflowRuns.id),
      ),
    )
    .where(
      inWorkspace(
        t.workflowRuns,
        inArray(t.workflowRuns.status, ['active', 'blocked']),
        or(
          eq(
            t.workflowRuns.coordinatorSessionId,
            param(t.workflowRuns.coordinatorSessionId, 'sessionId'),
          ),
          eq(
            t.workflowRunSteps.assignedSessionId,
            param(t.workflowRunSteps.assignedSessionId, 'sessionId'),
          ),
        ),
      ),
    )
    .orderBy(desc(t.workflowRuns.startedAt))
    .limit(1)
    .prepare(),
)

const insertRunRow = prepared((db, t) =>
  db
    .insert(t.workflowRuns)
    .values({
      workspaceId: WORKSPACE,
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
const insertRunSteps = preparedFamily((db, t, count: number) =>
  db
    .insert(t.workflowRunSteps)
    .values(
      Array.from({ length: count }, (_, i) => ({
        workspaceId: WORKSPACE,
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

const setRunStatus = prepared((db, t) =>
  db
    .update(t.workflowRuns)
    .set({ status: P('status'), completedAt: P('completedAt') })
    .where(inWorkspace(t.workflowRuns, eq(t.workflowRuns.id, param(t.workflowRuns.id, 'id'))))
    .prepare(),
)

const stepIs = (t: StoreTables) =>
  and(
    eq(t.workflowRunSteps.runId, param(t.workflowRunSteps.runId, 'runId')),
    eq(t.workflowRunSteps.stepId, param(t.workflowRunSteps.stepId, 'stepId')),
  )

const updateStepRow = prepared((db, t) =>
  db
    .update(t.workflowRunSteps)
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
    .where(inWorkspace(t.workflowRunSteps, stepIs(t)))
    .prepare(),
)

const assignStepRow = prepared((db, t) =>
  db
    .update(t.workflowRunSteps)
    .set({ assignedSessionId: P('sessionId') })
    .where(inWorkspace(t.workflowRunSteps, stepIs(t)))
    .prepare(),
)

const resetStepRow = prepared((db, t) =>
  db
    .update(t.workflowRunSteps)
    .set({
      status: 'pending',
      // READ-MODIFY-WRITE IN SQL. Binding a computed value would need a prior
      // read and would be a different statement with a different race.
      attempt: sql`${t.workflowRunSteps.attempt} + 1`,
      summary: '',
      evidenceJson: '{}',
      observationJson: null,
      warningsJson: '[]',
      startedAt: null,
      completedAt: null,
    })
    .where(inWorkspace(t.workflowRunSteps, stepIs(t)))
    .prepare(),
)

const appendEventRow = prepared((db, t) =>
  db
    .insert(t.workflowEvents)
    .values({
      workspaceId: WORKSPACE,
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

// ---- the synced records' reads (POD-6676) ----------------------------------

/** Under SQLite's bound-parameter limit, like the other batched readers. */
const ID_CHUNK = 500

/** Each asked workflow's owner and scope, for the feed's visibility pass. */
const workflowOwnersOfIds = preparedFamily((db, t, size: number) =>
  db
    .select({
      id: t.workflows.id,
      ownerUserId: t.workflows.ownerUserId,
      scope: t.workflows.scope,
    })
    .from(t.workflows)
    .where(inWorkspace(t.workflows, inListOf(t.workflows.id, size)))
    .prepare(),
)

/** Each asked revision's workflow, with that workflow's owner and scope: a
 *  revision is read as its workflow is (design §1.10). */
const revisionWorkflowsOfIds = preparedFamily((db, t, size: number) =>
  db
    .select({
      id: t.workflowRevisions.id,
      workflowId: t.workflowRevisions.workflowId,
      ownerUserId: t.workflows.ownerUserId,
      scope: t.workflows.scope,
    })
    .from(t.workflowRevisions)
    .innerJoin(
      t.workflows,
      and(
        sameWorkspace(t.workflows, t.workflowRevisions),
        eq(t.workflows.id, t.workflowRevisions.workflowId),
      ),
    )
    .where(inWorkspace(t.workflowRevisions, inListOf(t.workflowRevisions.id, size)))
    .prepare(),
)

/** The asked bindings of ONE target kind, through the primary key's prefix. */
const bindingOwnersOfTargets = preparedFamily((db, t, size: number) =>
  db
    .select({
      targetKind: t.workflowBindings.targetKind,
      targetId: t.workflowBindings.targetId,
      ownerUserId: t.workflowBindings.ownerUserId,
    })
    .from(t.workflowBindings)
    .where(
      inWorkspace(
        t.workflowBindings,
        eq(t.workflowBindings.targetKind, param(t.workflowBindings.targetKind, 'targetKind')),
        inListOf(t.workflowBindings.targetId, size),
      ),
    )
    .prepare(),
)

const runOwnersOfIds = preparedFamily((db, t, size: number) =>
  db
    .select({ id: t.workflowRuns.id, ownerUserId: t.workflowRuns.ownerUserId })
    .from(t.workflowRuns)
    .where(inWorkspace(t.workflowRuns, inListOf(t.workflowRuns.id, size)))
    .prepare(),
)

/** Every revision, for the boot reconcile (one read). */
const everyRevision = prepared((db, t) =>
  db
    .select()
    .from(t.workflowRevisions)
    .where(inWorkspace(t.workflowRevisions))
    .orderBy(asc(t.workflowRevisions.id))
    .prepare(),
)

/** Every run, live and terminal, with its revision's workflow (one read). */
const everyRun = prepared((db, t) =>
  db
    .select({ ...getTableColumns(t.workflowRuns), workflowId: t.workflowRevisions.workflowId })
    .from(t.workflowRuns)
    .innerJoin(
      t.workflowRevisions,
      and(
        sameWorkspace(t.workflowRevisions, t.workflowRuns),
        eq(t.workflowRevisions.id, t.workflowRuns.revisionId),
      ),
    )
    .where(inWorkspace(t.workflowRuns))
    .orderBy(asc(t.workflowRuns.id))
    .prepare(),
)

/** Every run step, for the boot reconcile (one read), in the primary key's
 *  `(run_id, step_id)` order; each run's steps are put in position order after. */
const everyRunStep = prepared((db, t) =>
  db
    .select()
    .from(t.workflowRunSteps)
    .where(inWorkspace(t.workflowRunSteps))
    .orderBy(asc(t.workflowRunSteps.runId), asc(t.workflowRunSteps.stepId))
    .prepare(),
)

/** The workflow family by id, for building its records by id (POD-6763). */
const workflowsOfIds = preparedFamily((db, t, size: number) =>
  db
    .select(workflowSelection(t))
    .from(t.workflows)
    .where(inWorkspace(t.workflows, inListOf(t.workflows.id, size, 'ids')))
    .prepare(),
)

const revisionsOfIds = preparedFamily((db, t, size: number) =>
  db
    .select()
    .from(t.workflowRevisions)
    .where(inWorkspace(t.workflowRevisions, inListOf(t.workflowRevisions.id, size, 'ids')))
    .prepare(),
)

const runsOfIds = preparedFamily((db, t, size: number) =>
  db
    .select({ ...getTableColumns(t.workflowRuns), workflowId: t.workflowRevisions.workflowId })
    .from(t.workflowRuns)
    .innerJoin(
      t.workflowRevisions,
      and(
        sameWorkspace(t.workflowRevisions, t.workflowRuns),
        eq(t.workflowRevisions.id, t.workflowRuns.revisionId),
      ),
    )
    .where(inWorkspace(t.workflowRuns, inListOf(t.workflowRuns.id, size, 'ids')))
    .prepare(),
)

/** The runs of these revisions (POD-6920: a revision's change reaches them). */
const runIdsOfRevisions = preparedFamily((db, t, size: number) =>
  db
    .select({ id: t.workflowRuns.id })
    .from(t.workflowRuns)
    .where(inWorkspace(t.workflowRuns, inListOf(t.workflowRuns.revisionId, size, 'ids')))
    .prepare(),
)

const stepsOfRuns = preparedFamily((db, t, size: number) =>
  db
    .select()
    .from(t.workflowRunSteps)
    .where(inWorkspace(t.workflowRunSteps, inListOf(t.workflowRunSteps.runId, size, 'ids')))
    .prepare(),
)

/** The owner and scope the feed decides a workflow-family row by. */
export interface WorkflowVisibilityFacts {
  /** workflow id → its owner (null for a row written before owners) and scope. */
  readonly workflows: ReadonlyMap<string, { ownerUserId: string | null; scope: WorkflowScope }>
  /** revision id → its workflow. */
  readonly revisions: ReadonlyMap<
    string,
    { workflowId: string; ownerUserId: string | null; scope: WorkflowScope }
  >
  /** binding row id (`kind:id`) → its owner. */
  readonly bindings: ReadonlyMap<string, string | null>
  /** run id → its owner. */
  readonly runs: ReadonlyMap<string, string | null>
}

export class WorkflowsRepository {
  /**
   * The capability is WIRING and is named here and nowhere else [spec rule 34].
   * A call site reads `this.db.select(…)` and `await this.createOrJoinTransaction(…)`.
   */
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * A GETTER, NOT A FIELD [spec rule 34a]. A field assigned in the constructor
   * freezes `db` to the ROOT instance, and rule 35 routes transactions
   * ambiently — `db` has to resolve the ENCLOSING transaction on every access.
   * B1 changes this one line, here, instead of turning 39 fields into getters.
   */
  protected get db(): WorkspaceDb {
    return this.scope
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

  /**
   * THE FACTS THE FEED DECIDES WORKFLOW ROWS BY (POD-6676), for one batch of
   * ids: at most one read per kind per 500 ids (bindings one per target kind
   * asked), never one per row. An id with no row is absent: nobody's.
   */
  async visibilityFacts(asked: {
    workflowIds: readonly string[]
    revisionIds: readonly string[]
    bindings: readonly { targetKind: WorkflowBindingTarget; targetId: string }[]
    runIds: readonly string[]
  }): Promise<WorkflowVisibilityFacts> {
    const chunks = function* (ids: readonly string[]) {
      const unique = [...new Set(ids)]
      for (let at = 0; at < unique.length; at += ID_CHUNK) yield unique.slice(at, at + ID_CHUNK)
    }
    const workflows = new Map<string, { ownerUserId: string | null; scope: WorkflowScope }>()
    for (const chunk of chunks(asked.workflowIds)) {
      const size = inListSize(chunk.length)
      for (const row of await workflowOwnersOfIds(this.db, size).all(inListValues(chunk, size))) {
        workflows.set(row.id, {
          ownerUserId: row.ownerUserId ?? null,
          scope: row.scope as WorkflowScope,
        })
      }
    }
    const revisions = new Map<
      string,
      { workflowId: string; ownerUserId: string | null; scope: WorkflowScope }
    >()
    for (const chunk of chunks(asked.revisionIds)) {
      const size = inListSize(chunk.length)
      for (const row of await revisionWorkflowsOfIds(this.db, size).all(
        inListValues(chunk, size),
      )) {
        revisions.set(row.id, {
          workflowId: row.workflowId,
          ownerUserId: row.ownerUserId ?? null,
          scope: row.scope as WorkflowScope,
        })
      }
    }
    const bindings = new Map<string, string | null>()
    const byKind = new Map<WorkflowBindingTarget, string[]>()
    for (const { targetKind, targetId } of asked.bindings) {
      const ids = byKind.get(targetKind) ?? []
      ids.push(targetId)
      byKind.set(targetKind, ids)
    }
    for (const [targetKind, ids] of byKind) {
      for (const chunk of chunks(ids)) {
        const size = inListSize(chunk.length)
        const values = { ...inListValues(chunk, size), targetKind }
        for (const row of await bindingOwnersOfTargets(this.db, size).all(values)) {
          bindings.set(`${row.targetKind}:${row.targetId}`, row.ownerUserId ?? null)
        }
      }
    }
    const runs = new Map<string, string | null>()
    for (const chunk of chunks(asked.runIds)) {
      const size = inListSize(chunk.length)
      for (const row of await runOwnersOfIds(this.db, size).all(inListValues(chunk, size))) {
        runs.set(row.id, row.ownerUserId ?? null)
      }
    }
    return { workflows, revisions, bindings, runs }
  }

  /** Every workflow, archived ones too, for the boot reconcile. */
  async allWorkflowsForBootReconcile(): Promise<WorkflowWire[]> {
    return await this.listWorkflows({ includeArchived: true })
  }

  /** Every revision, for the boot reconcile. */
  async allRevisionsForBootReconcile(): Promise<WorkflowRevisionWire[]> {
    return (await everyRevision(this.db).all()).map(toRevision)
  }

  /** Every run with its steps and its revision's workflow, for the boot
   *  reconcile: two reads whatever the number of runs. */
  async allRunsForBootReconcile(): Promise<
    Array<{ run: WorkflowRunRow; workflowId: string; steps: RunStep[] }>
  > {
    const steps = new Map<string, RunStep[]>()
    for (const row of await everyRunStep(this.db).all()) {
      const list = steps.get(row.runId) ?? []
      list.push(toRunStep(row))
      steps.set(row.runId, list)
    }
    for (const list of steps.values()) list.sort((a, b) => a.position - b.position)
    return (await everyRun(this.db).all()).map((row) => {
      const { workflowId, ...run } = row
      return { run: toRun(run), workflowId, steps: steps.get(row.id) ?? [] }
    })
  }

  /** {@link getWorkflow} for many ids; an absent id has no row (POD-6763). */
  async workflowsByIds(ids: readonly string[]): Promise<WorkflowWire[]> {
    return (await this.byIds(ids, (size, values) => workflowsOfIds(this.db, size).all(values))).map(
      toWorkflow,
    )
  }

  /** {@link getRevision} for many ids (POD-6763). */
  async revisionsByIds(ids: readonly string[]): Promise<WorkflowRevisionWire[]> {
    return (await this.byIds(ids, (size, values) => revisionsOfIds(this.db, size).all(values))).map(
      toRevision,
    )
  }

  /** Runs by id with their steps (position order) and their revision's
   *  workflow, the {@link allRunsForBootReconcile} shape (POD-6763). */
  async runsByIds(
    ids: readonly string[],
  ): Promise<Array<{ run: WorkflowRunRow; workflowId: string; steps: RunStep[] }>> {
    const rows = await this.byIds(ids, (size, values) => runsOfIds(this.db, size).all(values))
    const steps = new Map<string, RunStep[]>()
    const stepRows = await this.byIds(
      rows.map((row) => row.id),
      (size, values) => stepsOfRuns(this.db, size).all(values),
    )
    for (const row of stepRows) {
      const list = steps.get(row.runId) ?? []
      list.push(toRunStep(row))
      steps.set(row.runId, list)
    }
    for (const list of steps.values()) list.sort((a, b) => a.position - b.position)
    return rows.map((row) => {
      const { workflowId, ...run } = row
      return { run: toRun(run), workflowId, steps: steps.get(row.id) ?? [] }
    })
  }

  /** The ids of the runs of these revisions (POD-6920). */
  async runIdsOfRevisions(revisionIds: readonly string[]): Promise<string[]> {
    return (
      await this.byIds(revisionIds, (size, values) => runIdsOfRevisions(this.db, size).all(values))
    ).map((row) => row.id)
  }

  private async byIds<T>(
    ids: readonly string[],
    read: (size: number, values: Record<string, unknown>) => Promise<T[]>,
  ): Promise<T[]> {
    const unique = [...new Set(ids)]
    const out: T[] = []
    for (let at = 0; at < unique.length; at += 500) {
      const chunk = unique.slice(at, at + 500)
      const size = inListSize(chunk.length)
      out.push(...(await read(size, inListValues(chunk, size, 'ids'))))
    }
    return out
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
      return required(
        await this.getRevision(row.id),
        `workflow revision ${row.id} was not persisted`,
      )
    })
  }

  async publishRevision(revisionId: string, now: string): Promise<void> {
    await publishRevisionRow(this.db).run({ revisionId, now })
  }

  async getBinding(
    targetKind: WorkflowBindingTarget,
    targetId: string,
  ): Promise<WorkflowBindingWire | null> {
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
  async listRunsPage(opts: {
    before?: WorkflowRunCursor
    limit: number
  }): Promise<WorkflowRunRow[]> {
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
    return (await eventsOfRun(this.db).all({ runId })).map((row) => ({
      kind: row.kind,
      actorKind: row.actorKind,
      // NEVER substituted. A null actor id is a row whose actor predates the
      // column; inventing one would be a lie in an audit trail.
      actorId: row.actorId,
      onBehalfOf: row.onBehalfOf,
      createdAt: row.createdAt,
    }))
  }

  async findLiveRun(
    subjectKind: 'issue' | 'session',
    subjectId: string,
  ): Promise<WorkflowRunRow | null> {
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
        stepValues[`agentProfileJson${position}`] = step.profile
          ? JSON.stringify(step.profile)
          : null
      })
      await insertRunSteps(this.db, input.steps.length).run(stepValues)
    })
  }

  async updateRunStatus(
    id: string,
    status: WorkflowRunStatus,
    completedAt: string | null,
  ): Promise<void> {
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
