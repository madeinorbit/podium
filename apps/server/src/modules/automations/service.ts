/**
 * Scheduled automations (#470) [spec:SP-17db] — the service half.
 *
 * Owns the CRUD surface the Automations tab drives (list/create/update/remove/
 * setEnabled/runs) and the tick that turns a due automation into a real agent
 * session. The decision policy is factored out into decide.ts as a pure function
 * so it is table-testable; this class is the impure half: it reads the store,
 * applies the decisions, spawns, and records the run.
 *
 * Cron is a pure PRODUCER of sessions: it writes no events and needs no
 * dispatcher changes.
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import {
  automationOccurrenceRunId,
  type AgentKind,
  type AutomationScheduleKind,
  type AutomationSessionMode,
} from '@podium/protocol'
import type { Ledger } from '@podium/sync'
import type {
  AutomationRow,
  AutomationRunOutcome,
  AutomationRunRow,
  AutomationsRepository,
} from '../../store/automations'
import type { WriteFunnel } from '../funnel'
import { assertScheduleFloor, nextAfter, nextRunAfter, parseCron } from './cron'
import { type AutomationDecision, decideTick, type Schedulable } from './decide'

export interface AutomationsDeps {
  store: AutomationsRepository
  /** Durable metadata transaction + ordered delta path [spec:SP-3fe2]. */
  ledger: Pick<Ledger, 'commit' | 'reconcile'>
  /** Legacy snapshot tail after the ledger commit has landed. */
  funnel: Pick<WriteFunnel, 'publishComputed'>
  /** SessionsService.createSession, narrowed to what a scheduled spawn needs.
   *  NOT the `sessions.create` tRPC procedure — that stamps spawnedBy 'user'. */
  createSession(input: {
    cwd: string
    agentKind?: AgentKind
    model?: string
    effort?: string
    spawnedBy?: string
    title?: string
    issueId?: string
  }): { sessionId: string }
  /** SessionsService.queueText — the durable outbox (see `spawn` below for why
   *  this and not `initialPrompt`). */
  queueText(input: { sessionId: string; text: string; mutationId?: string }): {
    ok: boolean
    reason?: string
  }
  /** Wake and deliver to the previous run's session in resume mode. */
  resumeAndSend(input: { sessionId: string; text: string; mutationId?: string }): {
    ok: boolean
    reason?: string
  }
  /** A fresh run owns a fresh automation-typed issue and attached session. */
  createIssue(input: {
    repoPath: string
    title: string
    description: string
    defaultAgent: string
    defaultModel: string
    defaultEffort: string
    type: 'automation'
  }): { id: string }
  /** Sessions currently running — the overlap check's input. */
  liveSessionIds(): Set<string>
  now(): Date
  /** Where a GLOBAL (repo-less) automation runs. Injected for the tests. */
  homeDir?(): string
}

export interface AutomationInput {
  name: string
  /** null/absent = GLOBAL: the session runs in the home directory [spec:SP-17db]. */
  repoPath?: string | null
  scheduleKind?: AutomationScheduleKind
  cron?: string | null
  runAt?: string | null
  /** Existing session to wake and message; null uses the selected session mode. */
  targetSessionId?: string | null
  agentKind: string
  model?: string
  effort?: string
  prompt: string
  enabled?: boolean
  sessionMode?: AutomationSessionMode
}

class AutomationSpawnError extends Error {
  constructor(
    message: string,
    readonly sessionId: string | null,
  ) {
    super(message)
  }
}

export class AutomationsService {
  constructor(private readonly deps: AutomationsDeps) {
    // Full boot truth closes changes made while the server was down and seeds
    // both new durable kinds before a client can ask for its cursor.
    deps.ledger.reconcile(
      'automation',
      deps.store.list().map((automation) => ({ id: automation.id, value: automation })),
    )
    deps.ledger.reconcile(
      'automationRun',
      deps.store.listAllRuns().map((run) => ({ id: run.id, value: run })),
    )
  }

  private publishAutomations(): void {
    this.deps.funnel.publishComputed({
      type: 'automationsChanged',
      automations: this.deps.store.list(),
    })
  }

  private publishRuns(): void {
    this.deps.funnel.publishComputed({
      type: 'automationRunsChanged',
      automationRuns: this.deps.store.listAllRuns(),
    })
  }

  private now(): Date {
    return this.deps.now()
  }

  private homeDir(): string {
    return this.deps.homeDir ? this.deps.homeDir() : homedir()
  }

  /** The armed time for an automation, or null when it is disabled (or a cron can
   *  never fire again). One-off timestamps have already been validated as future. */
  private armFrom(
    scheduleKind: AutomationScheduleKind,
    cron: string | null,
    runAt: string | null,
    enabled: boolean,
  ): string | null {
    if (!enabled) return null
    if (scheduleKind === 'once') return runAt
    if (!cron) throw new Error('cron schedule is missing its expression')
    return nextRunAfter(cron, this.now())?.toISOString() ?? null
  }

  private validateSchedule(
    scheduleKind: AutomationScheduleKind,
    cron: string | null,
    runAt: string | null,
    requireFuture: boolean,
  ): void {
    if (scheduleKind === 'cron') {
      if (!cron) throw new Error('cron schedule requires an expression')
      parseCron(cron)
      assertScheduleFloor(cron, this.now())
      if (runAt !== null) throw new Error('cron schedule cannot also have a runAt timestamp')
      return
    }
    if (cron !== null) throw new Error('one-off schedule cannot also have a cron expression')
    const timestamp = runAt === null ? Number.NaN : Date.parse(runAt)
    if (!Number.isFinite(timestamp)) {
      throw new Error('one-off schedule requires a valid runAt timestamp')
    }
    if (requireFuture && timestamp <= this.now().getTime()) {
      throw new Error('one-off runAt timestamp must be in the future')
    }
  }

  list(): AutomationRow[] {
    return this.deps.store.list()
  }

  runs(automationId: string, limit?: number): AutomationRunRow[] {
    return this.deps.store.listRuns(automationId, limit)
  }

  allRuns(): AutomationRunRow[] {
    return this.deps.store.listAllRuns()
  }

  /** Create an automation. Validation happens before persistence, including the
   *  explicit one-minute floor [spec:SP-17db]. */
  create(input: AutomationInput): AutomationRow {
    const scheduleKind = input.scheduleKind ?? 'cron'
    const cron = input.cron?.trim() || null
    const runAt = input.runAt ? new Date(input.runAt).toISOString() : null
    this.validateSchedule(scheduleKind, cron, runAt, scheduleKind === 'once')
    const enabled = input.enabled ?? false
    const row: AutomationRow = {
      id: `aut_${randomUUID()}`,
      name: input.name.trim(),
      enabled,
      repoPath: input.repoPath?.trim() || null,
      scheduleKind,
      cron,
      runAt,
      targetSessionId: input.targetSessionId?.trim() || null,
      agentKind: input.agentKind,
      model: input.model ?? 'auto',
      effort: input.effort ?? 'auto',
      prompt: input.prompt,
      sessionMode: input.sessionMode ?? 'fresh',
      nextRunAt: this.armFrom(scheduleKind, cron, runAt, enabled),
      lastRunAt: null,
      createdAt: this.now().toISOString(),
    }
    const created = this.deps.ledger.commit({
      write: () => {
        this.deps.store.insert(row)
        return row
      },
      changes: (automation) => [
        { entity: 'automation', id: automation.id, op: 'upsert', value: automation },
      ],
    }).result
    this.publishAutomations()
    return created
  }

  /** Patch an automation. Any schedule/enabled change re-arms from now; an edited
   *  cron never retains the old expression's pending fire. */
  update(id: string, patch: Partial<AutomationInput>): AutomationRow {
    const current = this.deps.store.get(id)
    if (!current) throw new Error(`unknown automation: ${id}`)
    const scheduleKind = patch.scheduleKind ?? current.scheduleKind
    const cron = patch.cron !== undefined ? patch.cron?.trim() || null : current.cron
    const runAt =
      patch.runAt !== undefined
        ? patch.runAt
          ? new Date(patch.runAt).toISOString()
          : null
        : current.runAt
    const scheduleChanged =
      scheduleKind !== current.scheduleKind || cron !== current.cron || runAt !== current.runAt
    this.validateSchedule(scheduleKind, cron, runAt, scheduleKind === 'once' && scheduleChanged)
    const next: AutomationRow = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.repoPath !== undefined ? { repoPath: patch.repoPath?.trim() || null } : {}),
      scheduleKind,
      cron,
      runAt,
      ...(patch.targetSessionId !== undefined
        ? { targetSessionId: patch.targetSessionId?.trim() || null }
        : {}),
      ...(patch.agentKind !== undefined ? { agentKind: patch.agentKind } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.sessionMode !== undefined ? { sessionMode: patch.sessionMode } : {}),
    }
    if (
      next.scheduleKind === 'once' &&
      next.lastRunAt !== null &&
      patch.enabled === true &&
      !scheduleChanged
    ) {
      throw new Error('completed one-off schedule needs a new runAt timestamp before enabling')
    }
    if (scheduleChanged) next.lastRunAt = null
    const rearm = scheduleChanged || patch.enabled !== undefined
    if (rearm) {
      next.nextRunAt = this.armFrom(next.scheduleKind, next.cron, next.runAt, next.enabled)
    }
    const updated = this.deps.ledger.commit({
      write: () => {
        this.deps.store.update(next)
        return next
      },
      changes: (automation) => [
        { entity: 'automation', id: automation.id, op: 'upsert', value: automation },
      ],
    }).result
    this.publishAutomations()
    return updated
  }

  setEnabled(id: string, enabled: boolean): AutomationRow {
    return this.update(id, { enabled })
  }

  remove(id: string): { removed: boolean } {
    if (!this.deps.store.get(id)) return { removed: false }
    const runIds = this.deps.store
      .listAllRuns()
      .filter((run) => run.automationId === id)
      .map((run) => run.id)
    const removed = this.deps.ledger.commit({
      write: () => this.deps.store.remove(id),
      changes: (didRemove) =>
        didRemove
          ? [
              ...runIds.map((runId) => ({
                entity: 'automationRun' as const,
                id: runId,
                op: 'remove' as const,
              })),
              { entity: 'automation' as const, id, op: 'remove' as const },
            ]
          : [],
    }).result
    if (removed) {
      this.publishAutomations()
      this.publishRuns()
    }
    return { removed }
  }

  /**
   * One scheduler pass: decide, then apply. Public so the tests (and the scheduler's
   * timer) drive it directly. Every decision writes an `automation_runs` row — the
   * fires that deliberately did nothing (missed, skipped_overlap) are part of the
   * history, so a quiet night is explainable.
   */
  tick(): void {
    const decisions = decideTick({
      now: this.now(),
      automations: this.schedulables(),
      liveSessionIds: this.deps.liveSessionIds(),
    })
    for (const decision of decisions) this.apply(decision)
  }

  /** The decision function's input snapshot: the rows plus each automation's last
   *  spawned session (the overlap check's subject). */
  private schedulables(): Schedulable[] {
    const lastSessions = this.deps.store.lastSpawnedSessions()
    return this.deps.store.list().map((a) => ({
      id: a.id,
      enabled: a.enabled,
      scheduleKind: a.scheduleKind,
      cron: a.cron,
      nextRunAt: a.nextRunAt,
      lastSessionId: lastSessions.get(a.id) ?? null,
    }))
  }

  /**
   * Apply one decision. For spawn: reserve the occurrence run id BEFORE side
   * effects (without re-arming nextRunAt), execute spawn/outbox with that id as
   * mutationId, then finalize run + re-arm. A crash between reserve and finalize
   * leaves detail='reserved' so replay resumes rather than losing the occurrence.
   */
  private apply(decision: AutomationDecision): void {
    const automation = this.deps.store.get(decision.automationId)
    if (!automation) return
    const runId = automationOccurrenceRunId(automation.id, decision.firedAt)
    const existing = this.deps.store.getRun(runId)
    // Fully settled occurrence — idempotent no-op.
    if (existing && existing.detail !== 'reserved') return

    const rearmed: AutomationRow = {
      ...automation,
      enabled: automation.scheduleKind === 'once' ? false : automation.enabled,
      nextRunAt: decision.nextRunAt,
      lastRunAt: decision.firedAt,
    }

    // Non-spawn decisions have no side effects: record run + re-arm together.
    if (decision.kind !== 'spawn') {
      this.deps.ledger.commit({
        write: () => {
          if (!existing) {
            this.deps.store.addRun({
              id: runId,
              automationId: automation.id,
              firedAt: decision.firedAt,
              sessionId: null,
              outcome: decision.kind,
              detail: decision.detail ?? null,
            })
          } else {
            this.deps.store.updateRun(runId, {
              sessionId: null,
              outcome: decision.kind,
              detail: decision.detail ?? null,
            })
          }
          this.deps.store.update(rearmed)
          return { runId, automation: rearmed }
        },
        changes: (result) => [
          {
            entity: 'automationRun',
            id: result.runId,
            op: 'upsert',
            value: this.deps.store.getRun(result.runId)!,
          },
          {
            entity: 'automation',
            id: result.automation.id,
            op: 'upsert',
            value: result.automation,
          },
        ],
      })
      this.publishRuns()
      this.publishAutomations()
      return
    }

    // Reserve occurrence ONLY — do not re-arm nextRunAt until side effects finish.
    if (!existing) {
      this.deps.ledger.commit({
        write: () => {
          this.deps.store.addRun({
            id: runId,
            automationId: automation.id,
            firedAt: decision.firedAt,
            sessionId: null,
            outcome: 'error',
            detail: 'reserved',
          })
          return this.deps.store.getRun(runId)!
        },
        changes: (run) => [{ entity: 'automationRun', id: run.id, op: 'upsert', value: run }],
      })
    }

    let outcome: AutomationRunOutcome = 'error'
    let sessionId: string | null = null
    let detail: string | null = 'reserved'
    try {
      sessionId = this.spawn(automation, runId)
      outcome = 'spawned'
      detail = null
    } catch (err) {
      outcome = 'error'
      if (err instanceof AutomationSpawnError) sessionId = err.sessionId
      detail = err instanceof Error ? err.message : String(err)
      console.warn(`[podium:automations] ${automation.name} failed to spawn:`, err)
    }

    // Finalize run + re-arm only after the side-effect attempt (success or terminal error).
    this.deps.ledger.commit({
      write: () => {
        this.deps.store.updateRun(runId, { sessionId, outcome, detail })
        this.deps.store.update(rearmed)
        return { run: this.deps.store.getRun(runId)!, automation: rearmed }
      },
      changes: (result) => [
        { entity: 'automationRun', id: result.run.id, op: 'upsert', value: result.run },
        {
          entity: 'automation',
          id: result.automation.id,
          op: 'upsert',
          value: result.automation,
        },
      ],
    })
    this.publishRuns()
    this.publishAutomations()
  }

  /**
   * Fenced maintenance entry [POD-925]: apply one observed due occurrence after
   * the server revalidates schedule facts. A reserved-but-unfinished run is
   * resumed, not treated as already-applied.
   */
  applyObservedOccurrence(input: {
    automationId: string
    nextRunAt: string
    enabled: true
    liveSessionIds: Set<string>
    now: Date
  }): 'applied' | 'precondition' | 'not-due' | 'already' {
    const automation = this.deps.store.get(input.automationId)
    if (!automation || !automation.enabled || !input.enabled) return 'precondition'
    const runId = automationOccurrenceRunId(automation.id, input.nextRunAt)
    const existing = this.deps.store.getRun(runId)
    if (existing && existing.detail !== 'reserved') return 'already'

    // Resume reserved: nextRunAt was intentionally NOT re-armed, so it still matches.
    // Fresh: nextRunAt must still equal the observed due occurrence.
    if (!existing && automation.nextRunAt !== input.nextRunAt) return 'precondition'
    if (!existing) {
      const due = Date.parse(input.nextRunAt)
      if (!Number.isFinite(due) || due > input.now.getTime()) return 'not-due'
    }

    const nextRunAtForDecide = existing ? input.nextRunAt : automation.nextRunAt
    const decisions = decideTick({
      now: input.now,
      automations: [
        {
          id: automation.id,
          enabled: automation.enabled,
          scheduleKind: automation.scheduleKind,
          cron: automation.cron,
          nextRunAt: nextRunAtForDecide,
          lastSessionId: this.deps.store.lastSpawnedSessions().get(automation.id) ?? null,
        },
      ],
      liveSessionIds: input.liveSessionIds,
    })
    // For a reserved resume, decideTick may still yield spawn for the same occurrence.
    let decision = decisions[0]
    if (!decision && existing?.detail === 'reserved') {
      // Force resume spawn: recompute re-arm from now without requiring due again.
      let nextRunAt: string | null = null
      if (automation.scheduleKind === 'cron' && automation.cron) {
        try {
          nextRunAt = nextAfter(parseCron(automation.cron), input.now)?.toISOString() ?? null
        } catch {
          nextRunAt = null
        }
      }
      decision = {
        automationId: automation.id,
        kind: 'spawn',
        firedAt: input.nextRunAt,
        nextRunAt,
      }
    }
    if (!decision) return 'not-due'
    // Ensure firedAt stays the original occurrence identity.
    this.apply({ ...decision, firedAt: input.nextRunAt })
    return 'applied'
  }

  /**
   * Delivers the run into the selected conversation mode [spec:SP-17db].
   *
   * Resume mode reuses the last successful session. If that durable reference has
   * disappeared or never became resumable, the run safely falls back to a fresh
   * issue/session. Other resume failures are honest error runs. Fresh mode creates
   * an automation-typed issue for every occurrence and attaches the new session.
   *
   * Fresh prompt delivery uses queueText rather than initialPrompt so every harness
   * gets the turn through the durable outbox. The run id is the replay-safe outbox
   * mutation id.
   */
  private spawn(automation: AutomationRow, runId: string): string {
    if (automation.targetSessionId !== null || automation.sessionMode === 'resume') {
      const previousSessionId =
        automation.targetSessionId ?? this.deps.store.lastSpawnedSessions().get(automation.id)
      if (previousSessionId) {
        const resumed = this.deps.resumeAndSend({
          sessionId: previousSessionId,
          text: automation.prompt,
          mutationId: runId,
        })
        if (resumed.ok) return previousSessionId
        const reason = resumed.reason ?? 'unknown resume failure'
        if (
          automation.targetSessionId !== null ||
          (reason !== 'unknown session' && reason !== 'no resume ref')
        ) {
          throw new AutomationSpawnError(
            `session ${previousSessionId} rejected the scheduled resume: ${reason}`,
            previousSessionId,
          )
        }
      }
    }

    const cwd = automation.repoPath ?? this.homeDir()
    const issue = this.deps.createIssue({
      repoPath: cwd,
      title: automation.name,
      description: automation.prompt,
      defaultAgent: automation.agentKind,
      defaultModel: automation.model,
      defaultEffort: automation.effort,
      type: 'automation',
    })
    const { sessionId } = this.deps.createSession({
      cwd,
      agentKind: automation.agentKind as AgentKind,
      model: automation.model,
      effort: automation.effort,
      spawnedBy: `automation:${automation.id}`,
      title: automation.name,
      issueId: issue.id,
    })
    const queued = this.deps.queueText({ sessionId, text: automation.prompt, mutationId: runId })
    if (!queued.ok) {
      throw new AutomationSpawnError(
        `session ${sessionId} spawned but the prompt was rejected: ${queued.reason}`,
        sessionId,
      )
    }
    return sessionId
  }
}
