/**
 * KILLING A SESSION (POD-1396).
 *
 * Durable tombstone + live teardown for standalone kill, and the runtime-removal
 * half shared with issue-owned soft-delete. Split from session-teardown so the
 * stop/hibernate cluster and this kill cluster each stay under the 600-line
 * review signal.
 *
 * ORDERING CONTRACT (#247), load-bearing: the durable tombstone commits FIRST,
 * live teardown after. A commit throw must leave the session fully alive —
 * still in the map, clients attached, PTY not signalled — and propagate.
 * The remove change commits in the SAME transaction as the tombstone
 * ([spec:SP-3fe2]). Reversing either is invisible to types and to a passing build.
 *
 * Survival table (what survives) lives on session-teardown.ts; kill is the only
 * arm that tombstones the row.
 *
 * Dispose: none.
 */

import { createLogger } from '@podium/logger'
import type { SessionId, MachineId } from '@podium/model'
import type { MetadataChange } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import type { EntityChangeSpec, LedgerCommitOp, LedgerCommitResult } from '@podium/sync'
import type { AutoContinueController } from '../../auto-continue'
import type { ClientRegistry } from '../../gateway/client-registry'
import type { SessionStore } from '../../store'
import { afterCommit } from '../../store/executor/synchronous-span'
import type { EventBus } from '../bus'
import type { MachinesService } from '../machines/service'
import type { SessionDaemonProjection } from './daemon-projection'
import type { SessionRepository } from './repository'
import type { Session } from './session'
import type { SessionStateService } from './session-state/service'

const log = createLogger('server:sessions')

export type KillLedger = {
  commit<T>(op: LedgerCommitOp<T>): LedgerCommitResult<T>
}

export interface SessionKillPorts {
  store: SessionStore
  repository: SessionRepository
  state: SessionStateService
  autoContinue: Pick<AutoContinueController, 'onSessionGone'>
  sessions: Map<SessionId, Session>
  clients: ClientRegistry
  bus: EventBus
  machines: Pick<MachinesService, 'defaultMachine'>
  daemonProjection: Pick<SessionDaemonProjection, 'disposeTitle'>
  now(): number
  toMachine(machineId: MachineId, message: ControlMessage): void
  broadcastSessions(): void
  ledger: KillLedger
}

export class SessionKill {
  constructor(private readonly ports: SessionKillPorts) {}

  /** Durable transition for removing a local session. POD-309 removed the second
   *  spec this used to push: a retained hub-mirror entry colliding on the same id was
   *  revealed in the same ordered append. There is no mirror to reveal any more. */

  /** Durable transition for removing a local session. POD-309 removed the second
   *  spec this used to push: a retained hub-mirror entry colliding on the same id was
   *  revealed in the same ordered append. There is no mirror to reveal any more. */
  sessionRemovalSpecs(sessionId: SessionId): EntityChangeSpec[] {
    return [{ entity: 'session', id: sessionId, op: 'remove' }]
  }

  /** Runtime half of a durable session removal. Issue-owned tombstones can be
   * restored and therefore use generic process kill; standalone deletion is
   * terminal and emits the distinct binding-retirement instruction. */

  /** Runtime half of a durable session removal. Issue-owned tombstones can be
   * restored and therefore use generic process kill; standalone deletion is
   * terminal and emits the distinct binding-retirement instruction. */
  removeSessionRuntime(sessionId: SessionId, terminalRetirement?: { retiredAt: string }): void {
    const session = this.ports.sessions.get(sessionId)
    // The issues service owns the per-session Git attribution ledger. Notify it
    // while membership/cwd are still resolvable, before this removal.
    this.ports.bus.emit('issue.sessionDerived', { kind: 'removedOrArchived', sessionId })

    this.ports.toMachine(
      // The live Session is the truth while it exists; after it is dropped the durable
      // row still names the machine that ran it, and only a session with neither gets
      // the fleet default. Every arm is a machine some daemon actually answers to.
      session?.machineId ??
        this.ports.store.sessions.getSession(sessionId)?.machineId ??
        this.ports.machines.defaultMachine(),
      terminalRetirement
        ? {
            type: 'sessionBindingRetire',
            sessionId,
            transitionId: `retire:${sessionId}`,
            retiredAt: terminalRetirement.retiredAt,
            ...(session ? { durableLabel: session.durableLabel } : {}),
          }
        : {
            type: 'kill',
            sessionId,
            ...(session ? { durableLabel: session.durableLabel } : {}),
          },
    )
    this.ports.autoContinue.onSessionGone(sessionId)
    session?.terminal.detachAll()
    this.ports.sessions.delete(sessionId)
    this.ports.state.removeSession(sessionId)
    this.ports.daemonProjection.disposeTitle(sessionId)
    for (const c of this.ports.clients.values()) c.attached.delete(sessionId)
    this.ports.repository.forget(sessionId)
  }

  killSession(input: { sessionId: SessionId }): void {
    const session = this.ports.sessions.get(input.sessionId)
    const deletedAt = new Date(this.ports.now()).toISOString()
    // The remove change commits in the SAME transaction as the tombstone (and
    // the queued-send cleanup — a killed session can never deliver, so its rows
    // would only orphan until the next boot's sweep) [spec:SP-3fe2] #256: the
    // durable change log can never say something the sessions table doesn't.
    // Durable tombstone FIRST, live teardown after (#247): a commit throw leaves
    // the session fully alive — still in the map, clients attached, PTY not
    // signalled — and propagates to the caller, instead of tearing down live
    // state for a row the rolled-back transaction still holds.
    this.ports.ledger.commit({
      write: () => {
        this.ports.store.sessions.softDeleteSessions([input.sessionId], deletedAt, 'standalone')
        this.ports.store.sync.deleteQueuedMessagesForSession(input.sessionId)
      },
      changes: () => this.sessionRemovalSpecs(input.sessionId),
      // THE LIVE TEARDOWN WAITS FOR THE OUTERMOST COMMIT [POD-3366], which is
      // what the paragraph above always meant. "Durable tombstone FIRST, live
      // teardown after" was written against a top-level commit; nested inside a
      // caller's span this commit is a SAVEPOINT, and its release is not a
      // commit. The teardown is IRREVERSIBLE — the PTY is detached and every
      // client attachment dropped — so on that path it tore a session down for
      // a tombstone the enclosing span could still roll back, and there is no
      // un-kill to compensate with.
      apply: (_result, changes) => {
        this.removeSessionRuntime(input.sessionId, { retiredAt: deletedAt })
        this.ports.repository.publishSessionProjection(changes)
      },
    })
    // The broadcast and the death notification are mechanism 3: external
    // effects nobody waits for, whose failure must not be reported as a
    // divergent projection. `session` was captured before the commit, so the
    // notification can still resolve a session-spawner parent wake (POD-904)
    // after the row is gone.
    afterCommit(() => {
      this.ports.broadcastSessions()
      // Session-death notification [spec:SP-85d1] (lock auto-release et al.): a
      // kill deletes the row from the map BEFORE the daemon's agentExit
      // arrives, so the agentExit-path emit would be skipped — fire it here.
      // killSession is never the hibernate path (hibernateSession only flips
      // status).
      this.emitSessionExited(input.sessionId, session?.exitCode ?? -1, session?.spawnedBy, session)
    }, 'session-kill-broadcast')
  }

  /**
   * Real process death: bus fan-out (locks, messaging) AND a durable
   * `session.exited` row for the steward's session-parent wake (POD-904).
   * Hibernate does not land here. Best-effort log write — a store throw must
   * not undo the exit side-effects already applied.
   */

  /**
   * Real process death: bus fan-out (locks, messaging) AND a durable
   * `session.exited` row for the steward's session-parent wake (POD-904).
   * Hibernate does not land here. Best-effort log write — a store throw must
   * not undo the exit side-effects already applied.
   */
  emitSessionExited(
    sessionId: SessionId,
    code: number,
    spawnedBy?: string | null,
    sourceSession: Session | undefined = this.ports.sessions.get(sessionId),
  ): void {
    const session = sourceSession
    const lease = this.ports.store.observationCheckpoints.get(sessionId)
    const fence = lease?.checkpoint?.terminalFence
    const candidate = this.ports.store.observationCheckpoints.getTerminalCandidate(sessionId)
    // A fence suppresses the fixed steward exit fallback only while it still
    // describes the latest causal input. Historical/mixed-version fences without
    // their matching durable candidate, or a prompt sent after the fence, must let
    // the crash surface as a real exit.
    const terminalFenceReported = Boolean(
      session &&
        fence &&
        !fence.closing &&
        candidate &&
        candidate.facts.terminalTransitionId === fence.transitionId &&
        candidate.facts.inputCount === session.terminal.inputCount,
    )
    this.ports.bus.emit('session.exited', { sessionId, code })
    try {
      this.ports.store.events.appendEvent({
        ts: new Date(this.ports.now()).toISOString(),
        kind: 'session.exited',
        subject: sessionId,
        payload: {
          code,
          ...(terminalFenceReported ? { terminalFenceReported: true } : {}),
          ...(spawnedBy ? { spawnedBy } : {}),
        },
      })
    } catch {
      // Durable log is best-effort; bus subscribers already ran.
    }
  }
}
