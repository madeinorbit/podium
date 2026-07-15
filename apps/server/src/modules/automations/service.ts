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
import type { AgentKind, AutomationSessionMode } from '@podium/protocol'
import type { Ledger } from '@podium/sync'
import type {
  AutomationRow,
  AutomationRunOutcome,
  AutomationRunRow,
  AutomationsRepository,
} from '../../store/automations'
import type { WriteFunnel } from '../funnel'
import { assertScheduleFloor, nextRunAfter, parseCron } from './cron'
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
  cron: string
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

  /** The armed time for an automation, or null when it is disabled (or its cron can
   *  never fire again). Always strictly in the future. */
  private armFrom(cron: string, enabled: boolean): string | null {
    if (!enabled) return null
    return nextRunAfter(cron, this.now())?.toISOString() ?? null
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
    parseCron(input.cron)
    assertScheduleFloor(input.cron, this.now())
    const enabled = input.enabled ?? false
    const row: AutomationRow = {
      id: `aut_${randomUUID()}`,
      name: input.name.trim(),
      enabled,
      repoPath: input.repoPath?.trim() || null,
      cron: input.cron.trim(),
      agentKind: input.agentKind,
      model: input.model ?? 'auto',
      effort: input.effort ?? 'auto',
      prompt: input.prompt,
      sessionMode: input.sessionMode ?? 'fresh',
      nextRunAt: this.armFrom(input.cron, enabled),
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
    if (patch.cron !== undefined) {
      parseCron(patch.cron)
      assertScheduleFloor(patch.cron, this.now())
    }
    const next: AutomationRow = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.repoPath !== undefined ? { repoPath: patch.repoPath?.trim() || null } : {}),
      ...(patch.cron !== undefined ? { cron: patch.cron.trim() } : {}),
      ...(patch.agentKind !== undefined ? { agentKind: patch.agentKind } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.sessionMode !== undefined ? { sessionMode: patch.sessionMode } : {}),
    }
    const rearm = patch.cron !== undefined || patch.enabled !== undefined
    if (rearm) next.nextRunAt = this.armFrom(next.cron, next.enabled)
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
      cron: a.cron,
      nextRunAt: a.nextRunAt,
      lastSessionId: lastSessions.get(a.id) ?? null,
    }))
  }

  private apply(decision: AutomationDecision): void {
    const automation = this.deps.store.get(decision.automationId)
    if (!automation) return
    let outcome: AutomationRunOutcome
    let sessionId: string | null = null
    let detail = decision.detail ?? null
    const runId = `arun_${randomUUID()}`
    if (decision.kind === 'spawn') {
      try {
        sessionId = this.spawn(automation, runId)
        outcome = 'spawned'
      } catch (err) {
        outcome = 'error'
        if (err instanceof AutomationSpawnError) sessionId = err.sessionId
        detail = err instanceof Error ? err.message : String(err)
        console.warn(`[podium:automations] ${automation.name} failed to spawn:`, err)
      }
    } else {
      outcome = decision.kind
    }

    const run: AutomationRunRow = {
      id: runId,
      automationId: automation.id,
      firedAt: decision.firedAt,
      sessionId,
      outcome,
      detail,
    }
    const rearmed: AutomationRow = {
      ...automation,
      nextRunAt: decision.nextRunAt,
      lastRunAt: decision.firedAt,
    }
    this.deps.ledger.commit({
      write: () => {
        this.deps.store.addRun(run)
        this.deps.store.update(rearmed)
        return { run, automation: rearmed }
      },
      changes: (result) => [
        {
          entity: 'automationRun',
          id: result.run.id,
          op: 'upsert',
          value: result.run,
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
    if (automation.sessionMode === 'resume') {
      const previousSessionId = this.deps.store.lastSpawnedSessions().get(automation.id)
      if (previousSessionId) {
        const resumed = this.deps.resumeAndSend({
          sessionId: previousSessionId,
          text: automation.prompt,
          mutationId: runId,
        })
        if (resumed.ok) return previousSessionId
        const reason = resumed.reason ?? 'unknown resume failure'
        if (reason !== 'unknown session' && reason !== 'no resume ref') {
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
