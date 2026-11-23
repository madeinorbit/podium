/**
 * THE SESSION LIFECYCLE CONTROLLER (ADR 12 D5 E1, POD-6356).
 *
 * A session's record carries both halves of its lifecycle: `desired` (spec,
 * written by people and agents through `records.session.edit`) and `status`
 * (observed by the daemon). This controller makes the first true by acting
 * through the daemon channel, with the services that always did the work
 * (stop, hibernate, resurrect). It never writes `status` or the agent state:
 * the daemon stays the only judge of what a process is doing.
 *
 * LEVEL-TRIGGERED, BY REVISION. Every spec edit moves the record's `revision`;
 * the controller's acknowledgement is `observedRevision`. A session is PENDING
 * while `revision > observedRevision`, and only a pending session is acted on.
 * So an agent that exits on its own (desired still `running`, nothing pending)
 * is never restarted, and a replayed edit (the entry point answers it from its
 * dedup record, no new revision) does nothing.
 *
 * TRIGGERS, both of which only ask "is it pending, and what would make it so":
 *  1. after the commit of every edit on `sync.submit` (the fast path);
 *  2. a daemon attach: that machine's pending sessions (`machine.connected`).
 * There is no boot sweep, and none is needed: no daemon is attached when the
 * server starts, so every machine's attach after a restart is trigger 2, and an
 * edit for a machine that never comes back has nothing to act through.
 * A reconcile requested while one runs for the same session runs again after
 * it, so two quick edits end at the newest revision, each acted on at most once.
 *
 * OUTCOMES. An action that refuses (`{ ok: false, reason }`: a dirty worktree
 * stopped without force, nothing to resume from) is definitive: the controller
 * acknowledges the revision with `lifecycleFailure`, and the next edit clears
 * it. An action that THROWS, or a machine with no daemon, is transient: the
 * session stays pending for the next trigger. Nothing is retried on a timer.
 *
 * STARTING IS RE-AUTHORIZED AT ACT TIME. The entry point checked the edit's
 * target, machine `use` included, when it applied; an attach can come much
 * later. So before an action that STARTS work (`running`), the controller asks
 * whether the revision's writer may still use the machine, and refuses with
 * {@link NO_LONGER_ALLOWED} if not. Stop and hibernate are always acted on:
 * they only reduce work, and refusing them would keep a process running on a
 * machine its user may no longer use.
 *
 * SELF-STOP DEFERS ITS KILL (POD-6422). A stop whose revision the session's own
 * agent wrote (`byAgent` is the session) is that agent stopping itself, and the
 * agent is waiting for the answer: the action parks the row and frees the
 * worktree but leaves the process alive, answering `deferredKill`, and whoever
 * holds the reply ends it once the reply is out (the relay's after-reply hook,
 * `finishSelfStop`). Only on a commit's pass: a pass from a machine's reconnect
 * answers nobody, so it stops and kills as any stop does, and a retried
 * self-stop never leaves a parked row with a live process.
 *
 * MEMORY. The in-flight chain per session and the last outcome per session are
 * live runtime state (server-data: grows with activity, not history); every
 * fact the controller decides on is read from the row.
 */

import { createLogger } from '@podium/logger'
import type { MachineId, SessionDesired, SessionId } from '@podium/model'
import type { CommandPrincipal } from '../../command-principal'
import type { SessionLifecycleRow, SessionStatusPersisted } from '../../store'

const log = createLogger('server:session-lifecycle')

/** What the controller reads of one session, from its row. */
export interface LifecycleSnapshot {
  readonly sessionId: SessionId
  readonly machineId: MachineId
  readonly status: SessionStatusPersisted
  readonly lifecycle: SessionLifecycleRow
}

/** An action's answer, as the service returned it (its shape is the old route's). */
export interface LifecycleOutcome {
  readonly ok: boolean
  readonly reason?: string
  readonly [extra: string]: unknown
}

export interface LifecycleControllerPorts {
  read(sessionId: SessionId): Promise<LifecycleSnapshot | undefined>
  /** A machine's pending sessions. */
  pending(machineId: MachineId): Promise<readonly SessionId[]>
  /** Whether the machine's daemon is attached right now. */
  connected(machineId: MachineId): boolean
  /** `selfStop`: the session's own agent asked and waits for the answer; park
   *  and free, and leave the process for the reply's holder to end. */
  stop(
    sessionId: SessionId,
    force: boolean,
    principal?: CommandPrincipal,
    selfStop?: boolean,
  ): Promise<LifecycleOutcome>
  hibernate(sessionId: SessionId): Promise<LifecycleOutcome>
  resurrect(sessionId: SessionId): Promise<LifecycleOutcome>
  /**
   * Whether the writer of the session's current revision (`lifecycle.byUser`,
   * narrowed by `byAgent`) may still use its machine, asked at ACT time. Only
   * an action that starts work asks: stop and hibernate only reduce it.
   */
  mayStart(row: LifecycleSnapshot): Promise<boolean>
  /** Record that `revision` is done (or refused, with `failure`). A no-op when the
   *  record has moved past `revision` meanwhile. */
  acknowledge(sessionId: SessionId, revision: number, failure?: string): Promise<void>
}

export interface ReconcileHint {
  /** Who edited, for the audit trail of what the action does (a freed worktree). */
  readonly principal?: CommandPrincipal
  /** The pass a machine's reconnect asked for: nobody waits on its answer. */
  readonly reconnect?: true
}

/** Two requests for one pass: any request other than a reconnect's makes it a
 *  commit's pass (someone may be waiting on its answer). */
function mergeHints(previous: ReconcileHint | undefined, next: ReconcileHint): ReconcileHint {
  if (previous === undefined || previous.reconnect === next.reconnect) return next
  const { reconnect: _reconnect, ...commit } = next
  return { ...(previous.principal ? { principal: previous.principal } : {}), ...commit }
}

/** What one reconcile pass did. */
export type ReconcileResult =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'acknowledged'
      readonly revision: number
      readonly outcome?: LifecycleOutcome
    }
  | { readonly kind: 'waiting'; readonly revision: number; readonly why: 'offline' | 'transient' }

/** The refusal a start gets when its writer's `use` is gone. */
export const NO_LONGER_ALLOWED = 'no longer allowed to use this machine'

const isRunning = (status: SessionStatusPersisted): boolean =>
  status === 'live' || status === 'starting'

/**
 * Whether the observed state already is what `desired` asks, so there is
 * nothing to do. `stopped` is never satisfied by status alone: a stop also
 * frees the worktree, which a parked status cannot show, so the stop action
 * runs (and is idempotent on a parked session).
 */
export function satisfied(desired: SessionDesired, status: SessionStatusPersisted): boolean {
  switch (desired) {
    case 'running':
      return isRunning(status)
    case 'hibernated':
      return !isRunning(status)
    case 'stopped':
      return false
  }
}

export class SessionLifecycleController {
  private readonly chains = new Map<SessionId, Promise<ReconcileResult>>()
  private readonly again = new Map<SessionId, ReconcileHint>()
  private readonly outcomes = new Map<SessionId, { revision: number; outcome: LifecycleOutcome }>()

  constructor(private readonly ports: LifecycleControllerPorts) {}

  /**
   * Reconcile one session. Joins a pass already running for it and runs once
   * more after it, so the answer reflects every edit committed before the call.
   */
  reconcile(sessionId: SessionId, hint: ReconcileHint = {}): Promise<ReconcileResult> {
    const running = this.chains.get(sessionId)
    if (running) {
      this.again.set(sessionId, mergeHints(this.again.get(sessionId), hint))
      // The running chain takes the request on its next loop turn; if it had
      // already left its loop when the request came, the request is still
      // here when it settles, and runs now.
      return running.then((result) => {
        const left = this.again.get(sessionId)
        return left === undefined ? result : this.reconcile(sessionId, left)
      })
    }
    return this.start(sessionId, hint)
  }

  /** The outcome of the action taken for `revision`, once a pass has taken it. */
  outcomeFor(sessionId: SessionId, revision: number): LifecycleOutcome | undefined {
    const last = this.outcomes.get(sessionId)
    return last?.revision === revision ? last.outcome : undefined
  }

  /** Every pending session on a machine whose daemon just attached. */
  async reconcileMachine(machineId: MachineId): Promise<void> {
    const ids = await this.ports.pending(machineId)
    await Promise.all(
      ids.map((id) => this.reconcile(id, { reconnect: true }).catch(() => undefined)),
    )
  }

  private start(sessionId: SessionId, hint: ReconcileHint): Promise<ReconcileResult> {
    const chain = (async () => {
      let next: ReconcileHint | undefined = hint
      let result: ReconcileResult = { kind: 'idle' }
      while (next !== undefined) {
        this.again.delete(sessionId)
        result = await this.pass(sessionId, next)
        next = this.again.get(sessionId)
      }
      return result
    })().finally(() => {
      if (this.chains.get(sessionId) === chain) this.chains.delete(sessionId)
    })
    this.chains.set(sessionId, chain)
    return chain
  }

  private async pass(sessionId: SessionId, hint: ReconcileHint): Promise<ReconcileResult> {
    const row = await this.ports.read(sessionId)
    if (!row) return { kind: 'idle' }
    const { lifecycle, status, machineId } = row
    const revision = lifecycle.revision
    if (revision <= lifecycle.observedRevision || lifecycle.desired === null) {
      return { kind: 'idle' }
    }
    const desired = lifecycle.desired
    if (satisfied(desired, status)) {
      await this.ports.acknowledge(sessionId, revision)
      return { kind: 'acknowledged', revision }
    }
    if (!this.ports.connected(machineId)) {
      // Nothing is lost: the edit is durable and pending, and the machine's
      // reconnect reconciles it.
      return { kind: 'waiting', revision, why: 'offline' }
    }
    if (desired === 'running' && !(await this.ports.mayStart(row))) {
      const outcome: LifecycleOutcome = { ok: false, reason: NO_LONGER_ALLOWED }
      this.outcomes.set(sessionId, { revision, outcome })
      await this.ports.acknowledge(sessionId, revision, NO_LONGER_ALLOWED)
      return { kind: 'acknowledged', revision, outcome }
    }
    let outcome: LifecycleOutcome
    try {
      outcome = await this.act(row, desired, hint)
    } catch (error) {
      log.warn('session lifecycle action failed; left pending', {
        sessionId,
        desired,
        revision,
        error,
      })
      return { kind: 'waiting', revision, why: 'transient' }
    }
    this.outcomes.set(sessionId, { revision, outcome })
    await this.ports.acknowledge(
      sessionId,
      revision,
      outcome.ok ? undefined : (outcome.reason ?? `could not make the session ${desired}`),
    )
    return { kind: 'acknowledged', revision, outcome }
  }

  private async act(
    row: LifecycleSnapshot,
    desired: SessionDesired,
    hint: ReconcileHint,
  ): Promise<LifecycleOutcome> {
    const { sessionId, lifecycle } = row
    switch (desired) {
      case 'running':
        return await this.ports.resurrect(sessionId)
      case 'hibernated':
        return await this.ports.hibernate(sessionId)
      case 'stopped':
        return await this.ports.stop(
          sessionId,
          lifecycle.force,
          hint.principal,
          hint.reconnect !== true && lifecycle.byAgent === sessionId,
        )
    }
  }
}
