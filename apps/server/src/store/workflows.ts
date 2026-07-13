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
  type WorkflowRunStatus,
  type WorkflowRunStepStatus,
  WorkflowRunStepWire,
  type WorkflowScope,
  WorkflowStep,
  WorkflowStepEvidence,
  type WorkflowWire,
} from '@podium/protocol'
import type { SqlDatabase, SqlParam } from '@podium/runtime/sqlite'
import { transaction } from '@podium/runtime/sqlite'

export interface WorkflowActor {
  kind: 'operator' | 'session'
  id: string | null
}

export interface WorkflowRunRow {
  id: string
  subjectKind: 'issue' | 'session'
  subjectId: string
  coordinatorSessionId: string
  revisionId: string
  status: WorkflowRunStatus
  supersedesRunId: string | null
  startedAt: string
  completedAt: string | null
}

type Raw = Record<string, unknown>

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
function required<T>(value: T | null, message: string): T {
  if (value === null) throw new Error(message)
  return value
}

function parseJson<T>(raw: unknown, fallback: T): unknown {
  if (typeof raw !== 'string') return fallback
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return fallback
  }
}

function toWorkflow(row: Raw): WorkflowWire {
  return {
    id: text(row.id),
    name: text(row.name),
    description: text(row.description),
    scope: row.scope as WorkflowScope,
    scopeRef: nullableText(row.scope_ref),
    latestRevisionId: nullableText(row.latest_revision_id),
    latestVersion: Number(row.latest_version ?? 0),
    archivedAt: nullableText(row.archived_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  }
}

function toRevision(row: Raw): WorkflowRevisionWire {
  return {
    id: text(row.id),
    workflowId: text(row.workflow_id),
    version: Number(row.version),
    instructions: text(row.instructions),
    steps: WorkflowStep.array().parse(parseJson(row.steps_json, [])),
    createdAt: text(row.created_at),
    publishedAt: nullableText(row.published_at),
  }
}

function toBinding(row: Raw): WorkflowBindingWire {
  return {
    targetKind: row.target_kind as WorkflowBindingTarget,
    targetId: text(row.target_id),
    revisionId: text(row.revision_id),
    updatedAt: text(row.updated_at),
  }
}

function toProfile(row: Raw): ExecutionProfile {
  return ExecutionProfileWire.parse({
    id: row.id,
    name: row.name,
    accountId: row.account_id,
    machineId: row.machine_id ?? null,
    harness: row.harness,
    model: row.model,
    effort: row.effort,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function toRun(row: Raw): WorkflowRunRow {
  return {
    id: text(row.id),
    subjectKind: row.subject_kind as 'issue' | 'session',
    subjectId: text(row.subject_id),
    coordinatorSessionId: text(row.coordinator_session_id),
    revisionId: text(row.revision_id),
    status: row.status as WorkflowRunStatus,
    supersedesRunId: nullableText(row.supersedes_run_id),
    startedAt: text(row.started_at),
    completedAt: nullableText(row.completed_at),
  }
}

function toRunStep(row: Raw): RunStep {
  const profileRaw = parseJson(row.execution_profile_json, null)
  return WorkflowRunStepWire.parse({
    stepId: row.step_id,
    position: Number(row.position),
    title: row.title,
    instructions: row.instructions,
    completionGuidance: row.completion_guidance,
    executionProfileId: row.execution_profile_id ?? null,
    executionProfileSnapshot: profileRaw,
    status: row.status,
    assignedSessionId: row.assigned_session_id ?? null,
    attempt: Number(row.attempt),
    summary: row.summary,
    evidence: WorkflowStepEvidence.parse(parseJson(row.evidence_json, {})),
    observation:
      row.observation_json == null
        ? null
        : WorkflowGitObservation.parse(parseJson(row.observation_json, null)),
    warnings: parseJson(row.warnings_json, []),
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
  })
}

export class WorkflowsRepository {
  constructor(private readonly db: SqlDatabase) {}

  listWorkflows(
    opts: { includeArchived?: boolean; scope?: WorkflowScope; scopeRef?: string } = {},
  ): WorkflowWire[] {
    const clauses: string[] = []
    const values: SqlParam[] = []
    if (!opts.includeArchived) clauses.push('w.archived_at IS NULL')
    if (opts.scope) {
      clauses.push('w.scope = ?')
      values.push(opts.scope)
    }
    if (opts.scopeRef !== undefined) {
      clauses.push('w.scope_ref = ?')
      values.push(opts.scopeRef)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (
      this.db
        .prepare(
          `SELECT w.*,
                  COALESCE((SELECT MAX(r.version) FROM workflow_revisions r WHERE r.workflow_id = w.id), 0) AS latest_version
             FROM workflows w ${where}
            ORDER BY w.name COLLATE NOCASE, w.created_at`,
        )
        .all(...values) as Raw[]
    ).map(toWorkflow)
  }

  getWorkflow(id: string): WorkflowWire | null {
    const row = this.db
      .prepare(
        `SELECT w.*,
                COALESCE((SELECT MAX(r.version) FROM workflow_revisions r WHERE r.workflow_id = w.id), 0) AS latest_version
           FROM workflows w WHERE w.id = ?`,
      )
      .get(id) as Raw | undefined
    return row ? toWorkflow(row) : null
  }

  insertWorkflow(row: {
    id: string
    name: string
    description: string
    scope: WorkflowScope
    scopeRef: string | null
    actor: WorkflowActor
    now: string
  }): void {
    this.db
      .prepare(
        `INSERT INTO workflows
          (id, name, description, scope, scope_ref, created_by_kind, created_by_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.name,
        row.description,
        row.scope,
        row.scopeRef,
        row.actor.kind,
        row.actor.id,
        row.now,
        row.now,
      )
  }

  listRevisions(workflowId: string): WorkflowRevisionWire[] {
    return (
      this.db
        .prepare(`SELECT * FROM workflow_revisions WHERE workflow_id = ? ORDER BY version DESC`)
        .all(workflowId) as Raw[]
    ).map(toRevision)
  }

  getRevision(id: string): WorkflowRevisionWire | null {
    const row = this.db.prepare(`SELECT * FROM workflow_revisions WHERE id = ?`).get(id) as
      | Raw
      | undefined
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
    return transaction(this.db, () => {
      const next = this.db
        .prepare(
          `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM workflow_revisions WHERE workflow_id = ?`,
        )
        .get(row.workflowId) as { version: number }
      this.db
        .prepare(
          `INSERT INTO workflow_revisions
            (id, workflow_id, version, instructions, steps_json, created_by_kind, created_by_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.workflowId,
          Number(next.version),
          row.instructions,
          JSON.stringify(row.steps),
          row.actor.kind,
          row.actor.id,
          row.now,
        )
      this.db
        .prepare(`UPDATE workflows SET latest_revision_id = ?, updated_at = ? WHERE id = ?`)
        .run(row.id, row.now, row.workflowId)
      return required(this.getRevision(row.id), `workflow revision ${row.id} was not persisted`)
    })
  }

  publishRevision(revisionId: string, now: string): void {
    this.db
      .prepare(
        `UPDATE workflow_revisions SET published_at = COALESCE(published_at, ?) WHERE id = ?`,
      )
      .run(now, revisionId)
  }

  getBinding(targetKind: WorkflowBindingTarget, targetId: string): WorkflowBindingWire | null {
    const row = this.db
      .prepare(`SELECT * FROM workflow_bindings WHERE target_kind = ? AND target_id = ?`)
      .get(targetKind, targetId) as Raw | undefined
    return row ? toBinding(row) : null
  }

  listBindings(): WorkflowBindingWire[] {
    return (
      this.db
        .prepare(`SELECT * FROM workflow_bindings ORDER BY target_kind, target_id`)
        .all() as Raw[]
    ).map(toBinding)
  }

  setBinding(input: {
    targetKind: WorkflowBindingTarget
    targetId: string
    revisionId: string
    actor: WorkflowActor
    now: string
  }): WorkflowBindingWire {
    this.db
      .prepare(
        `INSERT INTO workflow_bindings
          (target_kind, target_id, revision_id, updated_by_kind, updated_by_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(target_kind, target_id) DO UPDATE SET
           revision_id = excluded.revision_id,
           updated_by_kind = excluded.updated_by_kind,
           updated_by_id = excluded.updated_by_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.targetKind,
        input.targetId,
        input.revisionId,
        input.actor.kind,
        input.actor.id,
        input.now,
      )
    return required(
      this.getBinding(input.targetKind, input.targetId),
      `workflow binding ${input.targetKind}:${input.targetId} was not persisted`,
    )
  }

  listProfiles(): ExecutionProfile[] {
    return (
      this.db
        .prepare(`SELECT * FROM execution_profiles ORDER BY name COLLATE NOCASE`)
        .all() as Raw[]
    ).map(toProfile)
  }

  getProfile(id: string): ExecutionProfile | null {
    const row = this.db.prepare(`SELECT * FROM execution_profiles WHERE id = ?`).get(id) as
      | Raw
      | undefined
    return row ? toProfile(row) : null
  }

  upsertProfile(input: {
    id: string
    name: string
    accountId: string
    machineId: string | null
    harness: string
    model: string
    effort: string
    actor: WorkflowActor
    now: string
  }): ExecutionProfile {
    this.db
      .prepare(
        `INSERT INTO execution_profiles
          (id, name, account_id, machine_id, harness, model, effort, created_by_kind, created_by_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           account_id = excluded.account_id,
           machine_id = excluded.machine_id,
           harness = excluded.harness,
           model = excluded.model,
           effort = excluded.effort,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.name,
        input.accountId,
        input.machineId,
        input.harness,
        input.model,
        input.effort,
        input.actor.kind,
        input.actor.id,
        input.now,
        input.now,
      )
    return required(this.getProfile(input.id), `execution profile ${input.id} was not persisted`)
  }

  listRuns(includeTerminal = false): WorkflowRunRow[] {
    const where = includeTerminal ? '' : `WHERE status IN ('active', 'blocked')`
    return (
      this.db
        .prepare(
          `SELECT * FROM workflow_runs ${where}
           ORDER BY started_at DESC`,
        )
        .all() as Raw[]
    ).map(toRun)
  }

  getRun(id: string): WorkflowRunRow | null {
    const row = this.db.prepare(`SELECT * FROM workflow_runs WHERE id = ?`).get(id) as
      | Raw
      | undefined
    return row ? toRun(row) : null
  }

  getRunSteps(runId: string): RunStep[] {
    return (
      this.db
        .prepare(`SELECT * FROM workflow_run_steps WHERE run_id = ? ORDER BY position`)
        .all(runId) as Raw[]
    ).map(toRunStep)
  }

  findLiveRun(subjectKind: 'issue' | 'session', subjectId: string): WorkflowRunRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM workflow_runs
          WHERE subject_kind = ? AND subject_id = ? AND status IN ('active', 'blocked')
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(subjectKind, subjectId) as Raw | undefined
    return row ? toRun(row) : null
  }

  findLiveRunForSession(sessionId: string): WorkflowRunRow | null {
    const row = this.db
      .prepare(
        `SELECT DISTINCT r.* FROM workflow_runs r
         LEFT JOIN workflow_run_steps s ON s.run_id = r.id
         WHERE r.status IN ('active', 'blocked')
           AND (r.coordinator_session_id = ? OR s.assigned_session_id = ?)
         ORDER BY r.started_at DESC LIMIT 1`,
      )
      .get(sessionId, sessionId) as Raw | undefined
    return row ? toRun(row) : null
  }

  insertRun(input: {
    run: WorkflowRunRow
    steps: Array<Step & { profile: ExecutionProfile | null }>
  }): void {
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO workflow_runs
            (id, subject_kind, subject_id, coordinator_session_id, revision_id, status,
             supersedes_run_id, started_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.run.id,
          input.run.subjectKind,
          input.run.subjectId,
          input.run.coordinatorSessionId,
          input.run.revisionId,
          input.run.status,
          input.run.supersedesRunId,
          input.run.startedAt,
          input.run.completedAt,
        )
      const insert = this.db.prepare(
        `INSERT INTO workflow_run_steps
          (run_id, step_id, position, title, instructions, completion_guidance,
           execution_profile_id, execution_profile_json, status, evidence_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', '{}')`,
      )
      input.steps.forEach((step, position) => {
        insert.run(
          input.run.id,
          step.id,
          position,
          step.title,
          step.instructions,
          step.completionGuidance,
          step.executionProfileId ?? null,
          step.profile ? JSON.stringify(step.profile) : null,
        )
      })
    })
  }

  updateRunStatus(id: string, status: WorkflowRunStatus, completedAt: string | null): void {
    this.db
      .prepare(`UPDATE workflow_runs SET status = ?, completed_at = ? WHERE id = ?`)
      .run(status, completedAt, id)
  }

  updateStep(input: {
    runId: string
    stepId: string
    status: WorkflowRunStepStatus
    assignedSessionId: string | null
    summary: string
    evidence: StepEvidence
    observation: GitObservation | null
    warnings: string[]
    startedAt: string | null
    completedAt: string | null
  }): void {
    this.db
      .prepare(
        `UPDATE workflow_run_steps SET
           status = ?, assigned_session_id = ?, summary = ?, evidence_json = ?,
           observation_json = ?, warnings_json = ?, started_at = ?, completed_at = ?
         WHERE run_id = ? AND step_id = ?`,
      )
      .run(
        input.status,
        input.assignedSessionId,
        input.summary,
        JSON.stringify(input.evidence),
        input.observation ? JSON.stringify(input.observation) : null,
        JSON.stringify(input.warnings),
        input.startedAt,
        input.completedAt,
        input.runId,
        input.stepId,
      )
  }

  assignStep(runId: string, stepId: string, sessionId: string | null): void {
    this.db
      .prepare(
        `UPDATE workflow_run_steps SET assigned_session_id = ? WHERE run_id = ? AND step_id = ?`,
      )
      .run(sessionId, runId, stepId)
  }

  resetStep(runId: string, stepId: string): void {
    this.db
      .prepare(
        `UPDATE workflow_run_steps SET
           status = 'pending', attempt = attempt + 1, summary = '', evidence_json = '{}',
           observation_json = NULL, warnings_json = '[]', started_at = NULL, completed_at = NULL
         WHERE run_id = ? AND step_id = ?`,
      )
      .run(runId, stepId)
  }

  appendEvent(input: {
    workflowId?: string | null
    runId?: string | null
    kind: string
    actor: WorkflowActor
    payload?: Record<string, unknown>
    now: string
  }): void {
    this.db
      .prepare(
        `INSERT INTO workflow_events
          (workflow_id, run_id, kind, actor_kind, actor_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.workflowId ?? null,
        input.runId ?? null,
        input.kind,
        input.actor.kind,
        input.actor.id,
        JSON.stringify(input.payload ?? {}),
        input.now,
      )
  }
}
