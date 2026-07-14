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
import type { AgentKind } from '@podium/protocol'
import type {
  AutomationRow,
  AutomationRunOutcome,
  AutomationRunRow,
  AutomationsRepository,
} from '../../store/automations'
import { assertScheduleFloor, nextRunAfter, parseCron } from './cron'
import { type AutomationDecision, decideTick, type Schedulable } from './decide'

export interface AutomationsDeps {
  store: AutomationsRepository
  /** SessionsService.createSession, narrowed to what a scheduled spawn needs.
   *  NOT the `sessions.create` tRPC procedure — that stamps spawnedBy 'user'. */
  createSession(input: {
    cwd: string
    agentKind?: AgentKind
    model?: string
    effort?: string
    spawnedBy?: string
  }): { sessionId: string }
  /** SessionsService.queueText — the durable outbox (see `spawn` below for why
   *  this and not `initialPrompt`). */
  queueText(input: { sessionId: string; text: string; mutationId?: string }): {
    ok: boolean
    reason?: string
  }
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
}

export class AutomationsService {
  constructor(private readonly deps: AutomationsDeps) {}

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

  /** Create an automation. Validates the cron up front so an unparseable expression
   *  is rejected at the composer, never persisted to fail silently at tick time —
   *  and enforces the 5-minute rate floor, so no schedule can spawn a runaway train
   *  of agent sessions [spec:SP-17db]. */
  create(input: AutomationInput): AutomationRow {
    parseCron(input.cron) // throws with a human-readable message
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
      nextRunAt: this.armFrom(input.cron, enabled),
      lastRunAt: null,
      createdAt: this.now().toISOString(),
    }
    this.deps.store.insert(row)
    return row
  }

  /** Patch an automation. Any change to the schedule or the enabled flag RE-ARMS it
   *  from now — an edited cron must not keep the old expression's pending fire. */
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
    }
    const rearm = patch.cron !== undefined || patch.enabled !== undefined
    if (rearm) next.nextRunAt = this.armFrom(next.cron, next.enabled)
    this.deps.store.update(next)
    return next
  }

  setEnabled(id: string, enabled: boolean): AutomationRow {
    return this.update(id, { enabled })
  }

  remove(id: string): { removed: boolean } {
    return { removed: this.deps.store.remove(id) }
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
    if (!automation) return // deleted between the snapshot and now
    let outcome: AutomationRunOutcome
    let sessionId: string | null = null
    let detail = decision.detail ?? null
    const runId = `arun_${randomUUID()}`
    if (decision.kind === 'spawn') {
      try {
        sessionId = this.spawn(automation, runId)
        outcome = 'spawned'
      } catch (err) {
        // A throwing spawn must not take down the tick (or the timer): record it and
        // move on — the automation stays armed for its next occurrence.
        outcome = 'error'
        detail = err instanceof Error ? err.message : String(err)
        console.warn(`[podium:automations] ${automation.name} failed to spawn:`, err)
      }
    } else {
      outcome = decision.kind
    }
    this.deps.store.addRun({
      id: runId,
      automationId: automation.id,
      firedAt: decision.firedAt,
      sessionId,
      outcome,
      detail,
    })
    this.deps.store.update({
      ...automation,
      nextRunAt: decision.nextRunAt,
      lastRunAt: decision.firedAt,
    })
  }

  /**
   * Spawn the automation's session and hand it the prompt.
   *
   * The prompt goes through `queueText`, NOT `createSession({ initialPrompt })`:
   * `initialPrompt` is delivered via argv and only for argv-capable harnesses
   * (claude-code/codex/grok); for opencode and cursor it is silently seeded into
   * the composer draft and never sent — a scheduled task that quietly does nothing
   * on two of five harnesses is a trap. `queueText` is the durable outbox: it waits
   * for the session to be genuinely ready, survives a server restart, and works for
   * every harness. `mutationId = runId` makes prompt delivery replay-safe.
   *
   * `createSession` does no filesystem validation on `cwd`, and with no daemon
   * online the control message queues and flushes on the daemon's next attach —
   * both are the desired behavior for a scheduled spawn, not a failure [spec:SP-17db].
   */
  private spawn(automation: AutomationRow, runId: string): string {
    const { sessionId } = this.deps.createSession({
      // repo_path IS NULL = a GLOBAL automation: cross-repo chores run in $HOME.
      cwd: automation.repoPath ?? this.homeDir(),
      agentKind: automation.agentKind as AgentKind, // safeParsed inside createSession
      model: automation.model,
      effort: automation.effort,
      spawnedBy: `automation:${automation.id}`,
    })
    const queued = this.deps.queueText({ sessionId, text: automation.prompt, mutationId: runId })
    // A session with no prompt is not a run — it is a stray agent sitting at a
    // prompt. Surface it as an `error` run (naming the orphan session so it can be
    // found) rather than a `spawned` one that silently did nothing.
    if (!queued.ok) {
      throw new Error(`session ${sessionId} spawned but the prompt was rejected: ${queued.reason}`)
    }
    return sessionId
  }
}
