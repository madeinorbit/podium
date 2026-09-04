import type { AccountId, MachineId, SessionId, UserId } from '@podium/model'
import { asUserId } from '@podium/model'
import {
  type ExecutionProfileWire as ExecutionProfile,
  ExecutionProfileWire,
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
  executionProfiles,
  workflowBindings,
  workflowEvents,
  workflowRevisions,
  workflowRunSteps,
  workflowRuns,
  workflows as workflowsTable,
} from '../migrations/schema'
import type { StoreQueries, SyncDrizzle, TransactionRunner } from './executor/sync-drizzle'

/**
 * DISCRIMINATED (POD-362), was `{ kind: 'operator' | 'session'; id: string | null }`.
 * Every producer already obeys the correlation — router.ts emits
 * `{ kind: 'operator', id: null }` and the three session producers emit a real
 * session id — but the old shape let `{ kind: 'operator', id: <something> }` be
 * built, so `id` could not carry `SessionId` without lying on the operator arm.
 * As a union the brand is exact and the illegal pair is unrepresentable.
 */
export type WorkflowActor = { kind: 'operator'; id: null } | { kind: 'session'; id: SessionId }

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

function toProfile(row: typeof executionProfiles.$inferSelect): ExecutionProfile {
  return ExecutionProfileWire.parse({
    id: row.id,
    name: row.name,
    accountId: row.accountId,
    machineId: row.machineId ?? null,
    harness: row.harness,
    model: row.model,
    effort: row.effort,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
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
    ownerUserId: asUserId(row.ownerUserId),
  }
}

function toRunStep(row: typeof workflowRunSteps.$inferSelect): RunStep {
  const profileRaw = parseJson(row.executionProfileJson, null)
  return WorkflowRunStepWire.parse({
    stepId: row.stepId,
    position: row.position,
    title: row.title,
    instructions: row.instructions,
    completionGuidance: row.completionGuidance,
    executionProfileId: row.executionProfileId ?? null,
    executionProfileSnapshot: profileRaw,
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

export class WorkflowsRepository {
  /**
   * The capability is WIRING and is named here and nowhere else [spec rule 34].
   * A call site reads `this.db.select(…)` and `this.createOrJoinTransaction(…)`.
   */
  private readonly rootDb: SyncDrizzle
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
  protected get db(): SyncDrizzle {
    return this.rootDb
  }

  ownerOf(kind: string, id: string): string | null {
    let row: { ownerUserId?: UserId | null } | undefined
    if (kind === 'workflow-definition' || kind === 'workflow-library-entry') {
      row = this.db
        .select({ ownerUserId: workflowsTable.ownerUserId })
        .from(workflowsTable)
        .where(eq(workflowsTable.id, id))
        .get()
    } else if (kind === 'workflow-revision') {
      row = this.db
        .select({ ownerUserId: workflowsTable.ownerUserId })
        .from(workflowRevisions)
        .innerJoin(workflowsTable, eq(workflowsTable.id, workflowRevisions.workflowId))
        .where(eq(workflowRevisions.id, id))
        .get()
    } else if (kind === 'workflow-binding') {
      const split = id.indexOf(':')
      if (split < 0) return null
      row = this.db
        .select({ ownerUserId: workflowBindings.ownerUserId })
        .from(workflowBindings)
        .where(
          and(
            eq(workflowBindings.targetKind, id.slice(0, split)),
            eq(workflowBindings.targetId, id.slice(split + 1)),
          ),
        )
        .get()
    } else if (kind === 'execution-profile') {
      row = this.db
        .select({ ownerUserId: executionProfiles.ownerUserId })
        .from(executionProfiles)
        .where(eq(executionProfiles.id, id))
        .get()
    } else if (kind === 'workflow-run') {
      row = this.db
        .select({ ownerUserId: workflowRuns.ownerUserId })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, id))
        .get()
    }
    return typeof row?.ownerUserId === 'string' ? row.ownerUserId : null
  }

  listWorkflows(
    opts: { includeArchived?: boolean; scope?: WorkflowScope; scopeRef?: string } = {},
  ): WorkflowWire[] {
    const clauses: SQL[] = []
    if (!opts.includeArchived) clauses.push(isNull(workflowsTable.archivedAt))
    if (opts.scope) clauses.push(eq(workflowsTable.scope, opts.scope))
    // `!== undefined`, not truthiness: an explicit scopeRef of null binds null
    // and therefore matches nothing, which is what this has always done. See the
    // pin in store/workflows-golden.test.ts.
    if (opts.scopeRef !== undefined) clauses.push(eq(workflowsTable.scopeRef, opts.scopeRef))
    return (
      this.db
        .select(workflowSelection)
        .from(workflowsTable)
        .where(clauses.length ? and(...clauses) : undefined)
        // COLLATE NOCASE: with a binary collation 'Zebra' would sort before 'apple'.
        .orderBy(sql`${workflowsTable.name} COLLATE NOCASE`, asc(workflowsTable.createdAt))
        .all()
        .map(toWorkflow)
    )
  }

  getWorkflow(id: string): WorkflowWire | null {
    const row = this.db
      .select(workflowSelection)
      .from(workflowsTable)
      .where(eq(workflowsTable.id, id))
      .get()
    return row ? toWorkflow(row) : null
  }

  insertWorkflow(row: {
    id: string
    name: string
    description: string
    scope: WorkflowScope
    scopeRef: string | null
    actor: WorkflowActor
    ownerUserId: UserId
    now: string
  }): void {
    this.db
      .insert(workflowsTable)
      .values({
        id: row.id,
        name: row.name,
        description: row.description,
        scope: row.scope,
        scopeRef: row.scopeRef,
        createdByKind: row.actor.kind,
        createdById: row.actor.id,
        ownerUserId: row.ownerUserId,
        createdAt: row.now,
        updatedAt: row.now,
      })
      .run()
  }

  listRevisions(workflowId: string): WorkflowRevisionWire[] {
    return this.db
      .select()
      .from(workflowRevisions)
      .where(eq(workflowRevisions.workflowId, workflowId))
      .orderBy(desc(workflowRevisions.version))
      .all()
      .map(toRevision)
  }

  getRevision(id: string): WorkflowRevisionWire | null {
    const row = this.db.select().from(workflowRevisions).where(eq(workflowRevisions.id, id)).get()
    return row ? toRevision(row) : null
  }

  insertRevision(row: {
    id: string
    workflowId: string
    instructions: string
    steps: Step[]
    actor: WorkflowActor
    now: string
  }): WorkflowRevisionWire {
    // READ-DECIDE-WRITE. The version is allocated from MAX(version)+1 and then
    // inserted at, so the span is the allocation's atomicity and not decoration.
    return this.createOrJoinTransaction(() => {
      const next = this.db
        .select({ version: max(workflowRevisions.version) })
        .from(workflowRevisions)
        .where(eq(workflowRevisions.workflowId, row.workflowId))
        .get()
      this.db
        .insert(workflowRevisions)
        .values({
          id: row.id,
          workflowId: row.workflowId,
          version: Number(next?.version ?? 0) + 1,
          instructions: row.instructions,
          stepsJson: JSON.stringify(row.steps),
          createdByKind: row.actor.kind,
          createdById: row.actor.id,
          createdAt: row.now,
        })
        .run()
      this.db
        .update(workflowsTable)
        .set({ latestRevisionId: row.id, updatedAt: row.now })
        .where(eq(workflowsTable.id, row.workflowId))
        .run()
      return required(this.getRevision(row.id), `workflow revision ${row.id} was not persisted`)
    })
  }

  publishRevision(revisionId: string, now: string): void {
    this.db
      .update(workflowRevisions)
      // COALESCE: a published revision has ONE publication moment, so a repeat
      // must not re-date it.
      .set({ publishedAt: sql`COALESCE(${workflowRevisions.publishedAt}, ${now})` })
      .where(eq(workflowRevisions.id, revisionId))
      .run()
  }

  getBinding(targetKind: WorkflowBindingTarget, targetId: string): WorkflowBindingWire | null {
    const row = this.db
      .select()
      .from(workflowBindings)
      .where(
        and(eq(workflowBindings.targetKind, targetKind), eq(workflowBindings.targetId, targetId)),
      )
      .get()
    return row ? toBinding(row) : null
  }

  listBindings(): WorkflowBindingWire[] {
    return this.db
      .select()
      .from(workflowBindings)
      .orderBy(asc(workflowBindings.targetKind), asc(workflowBindings.targetId))
      .all()
      .map(toBinding)
  }

  setBinding(input: {
    targetKind: WorkflowBindingTarget
    targetId: string
    revisionId: string
    actor: WorkflowActor
    ownerUserId: UserId
    now: string
  }): WorkflowBindingWire {
    this.db
      .insert(workflowBindings)
      .values({
        targetKind: input.targetKind,
        targetId: input.targetId,
        revisionId: input.revisionId,
        updatedByKind: input.actor.kind,
        updatedById: input.actor.id,
        ownerUserId: input.ownerUserId,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [workflowBindings.targetKind, workflowBindings.targetId],
        // FOUR COLUMNS, and `owner_user_id` is deliberately not among them: a
        // rebind may not change the resource owner `ownerOf` authorizes from.
        set: {
          revisionId: input.revisionId,
          updatedByKind: input.actor.kind,
          updatedById: input.actor.id,
          updatedAt: input.now,
        },
      })
      .run()
    return required(
      this.getBinding(input.targetKind, input.targetId),
      `workflow binding ${input.targetKind}:${input.targetId} was not persisted`,
    )
  }

  listProfiles(): ExecutionProfile[] {
    return this.db
      .select()
      .from(executionProfiles)
      .orderBy(sql`${executionProfiles.name} COLLATE NOCASE`)
      .all()
      .map(toProfile)
  }

  getProfile(id: string): ExecutionProfile | null {
    const row = this.db.select().from(executionProfiles).where(eq(executionProfiles.id, id)).get()
    return row ? toProfile(row) : null
  }

  upsertProfile(input: {
    id: string
    name: string
    accountId: AccountId
    machineId: MachineId | null
    harness: string
    model: string
    effort: string
    actor: WorkflowActor
    ownerUserId: UserId
    now: string
  }): ExecutionProfile {
    this.db
      .insert(executionProfiles)
      .values({
        id: input.id,
        name: input.name,
        accountId: input.accountId,
        machineId: input.machineId,
        harness: input.harness,
        model: input.model,
        effort: input.effort,
        createdByKind: input.actor.kind,
        createdById: input.actor.id,
        ownerUserId: input.ownerUserId,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: executionProfiles.id,
        // `created_by_*` and `owner_user_id` are absent on purpose: an update
        // may not re-attribute or re-own a profile.
        set: {
          name: input.name,
          accountId: input.accountId,
          machineId: input.machineId,
          harness: input.harness,
          model: input.model,
          effort: input.effort,
          updatedAt: input.now,
        },
      })
      .run()
    return required(this.getProfile(input.id), `execution profile ${input.id} was not persisted`)
  }

  listRuns(includeTerminal = false): WorkflowRunRow[] {
    return this.db
      .select()
      .from(workflowRuns)
      .where(includeTerminal ? undefined : inArray(workflowRuns.status, ['active', 'blocked']))
      .orderBy(desc(workflowRuns.startedAt))
      .all()
      .map(toRun)
  }

  getRun(id: string): WorkflowRunRow | null {
    const row = this.db.select().from(workflowRuns).where(eq(workflowRuns.id, id)).get()
    return row ? toRun(row) : null
  }

  getRunSteps(runId: string): RunStep[] {
    return this.db
      .select()
      .from(workflowRunSteps)
      .where(eq(workflowRunSteps.runId, runId))
      .orderBy(asc(workflowRunSteps.position))
      .all()
      .map(toRunStep)
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
  listRunEvents(runId: string): WorkflowRunEventWire[] {
    return this.db
      .select({
        kind: workflowEvents.kind,
        actorKind: workflowEvents.actorKind,
        actorId: workflowEvents.actorId,
        onBehalfOf: workflowEvents.onBehalfOf,
        createdAt: workflowEvents.createdAt,
      })
      .from(workflowEvents)
      .where(eq(workflowEvents.runId, runId))
      .orderBy(asc(workflowEvents.id))
      .all()
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

  findLiveRun(subjectKind: 'issue' | 'session', subjectId: string): WorkflowRunRow | null {
    const row = this.db
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.subjectKind, subjectKind),
          eq(workflowRuns.subjectId, subjectId),
          inArray(workflowRuns.status, ['active', 'blocked']),
        ),
      )
      .orderBy(desc(workflowRuns.startedAt))
      .limit(1)
      .get()
    return row ? toRun(row) : null
  }

  findLiveRunForSession(sessionId: SessionId): WorkflowRunRow | null {
    const row = this.db
      .selectDistinct(getTableColumns(workflowRuns))
      .from(workflowRuns)
      .leftJoin(workflowRunSteps, eq(workflowRunSteps.runId, workflowRuns.id))
      .where(
        and(
          inArray(workflowRuns.status, ['active', 'blocked']),
          or(
            eq(workflowRuns.coordinatorSessionId, sessionId),
            eq(workflowRunSteps.assignedSessionId, sessionId),
          ),
        ),
      )
      .orderBy(desc(workflowRuns.startedAt))
      .limit(1)
      .get()
    return row ? toRun(row) : null
  }

  insertRun(input: {
    run: WorkflowRunRow
    steps: Array<Step & { profile: ExecutionProfile | null }>
  }): void {
    this.createOrJoinTransaction(() => {
      this.db
        .insert(workflowRuns)
        .values({
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
        .run()
      // No steps means NO statement, as the `forEach` this replaces did.
      if (input.steps.length === 0) return
      this.db
        .insert(workflowRunSteps)
        .values(
          input.steps.map((step, position) => ({
            runId: input.run.id,
            stepId: step.id,
            position,
            title: step.title,
            instructions: step.instructions,
            completionGuidance: step.completionGuidance,
            executionProfileId: step.executionProfileId ?? null,
            executionProfileJson: step.profile ? JSON.stringify(step.profile) : null,
            // The two literals the raw INSERT carried, kept explicit rather than
            // left to the column defaults, which is what it did.
            status: 'pending',
            evidenceJson: '{}',
          })),
        )
        .run()
    })
  }

  updateRunStatus(id: string, status: WorkflowRunStatus, completedAt: string | null): void {
    this.db.update(workflowRuns).set({ status, completedAt }).where(eq(workflowRuns.id, id)).run()
  }

  updateStep(input: {
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
  }): void {
    this.db
      .update(workflowRunSteps)
      .set({
        status: input.status,
        assignedSessionId: input.assignedSessionId,
        summary: input.summary,
        evidenceJson: JSON.stringify(input.evidence),
        observationJson: input.observation ? JSON.stringify(input.observation) : null,
        warningsJson: JSON.stringify(input.warnings),
        startedAt: input.startedAt,
        completedAt: input.completedAt,
      })
      .where(
        and(eq(workflowRunSteps.runId, input.runId), eq(workflowRunSteps.stepId, input.stepId)),
      )
      .run()
  }

  assignStep(runId: string, stepId: string, sessionId: SessionId | null): void {
    this.db
      .update(workflowRunSteps)
      .set({ assignedSessionId: sessionId })
      .where(and(eq(workflowRunSteps.runId, runId), eq(workflowRunSteps.stepId, stepId)))
      .run()
  }

  resetStep(runId: string, stepId: string): void {
    this.db
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
      .where(and(eq(workflowRunSteps.runId, runId), eq(workflowRunSteps.stepId, stepId)))
      .run()
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
  appendEvent(input: {
    workflowId?: string | null
    runId?: string | null
    kind: string
    actor: WorkflowActor
    /** The delegating human. `null`/absent = a system principal, or a row from
     *  before the column existed — never "the operator" by default. */
    onBehalfOf?: string | null
    payload?: Record<string, unknown>
    now: string
  }): void {
    this.db
      .insert(workflowEvents)
      .values({
        workflowId: input.workflowId ?? null,
        runId: input.runId ?? null,
        kind: input.kind,
        actorKind: input.actor.kind,
        actorId: input.actor.id,
        onBehalfOf: input.onBehalfOf ?? null,
        payloadJson: JSON.stringify(input.payload ?? {}),
        createdAt: input.now,
      })
      .run()
  }
}
