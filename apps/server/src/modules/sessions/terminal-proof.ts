/**
 * TERMINAL OBSERVATION PROOF (POD-1396, from POD-1385's god-object audit).
 *
 * One question, asked in one place: *is there a valid, unconsumed proof that
 * this session has genuinely finished its turn and nothing is still in flight?*
 * Hibernation and the host reaper both hang off the answer, and getting it
 * wrong parks a session that is still working.
 *
 * WHY THIS IS A REAL SEAM AND NOT A LINE-COUNT CUT. The boundary was already
 * implied by the code before this module existed: `SessionLifecycle` passed
 * `terminalCandidateFacts` into `SessionDaemonLifecycle` as an explicit PORT,
 * which is a module handing a neighbour one coherent capability by name. The
 * five methods here were the only readers of that capability, they share their
 * own inputs, and nothing else in `lifecycle.ts` reads them. This module is
 * that port, given a home.
 *
 * WHAT IT OWNS AND WHAT IT ONLY READS. It owns the observation LEASE BOOK
 * ({@link SessionObservationLeases}) because fencing allocates a lease and the
 * proof reads it back; the repository's boot hydration and the daemon
 * lifecycle's rebind writes reach the same book through their own reference to
 * it. Everything else — sessions, store, drain state, auto-continue — arrives
 * through narrow ports and is READ ONLY. This module writes nothing except a
 * fenced lease.
 *
 * THE ORDER MATTERS AND IS NOT AN ACCIDENT. `facts()` gathers; `consumable()`
 * judges the gathered facts; `hasValidProof()` requires BOTH that the durable
 * proof matches the facts byte-for-byte AND that those facts are consumable.
 * Splitting gather from judge is what lets the daemon lifecycle record a
 * candidate at observation time and the hibernate path re-derive it later and
 * compare — if the session did anything in between, the JSON differs and the
 * proof is refused.
 */

import { isSpawnedBy } from '@podium/model'
import { harnessObservationProvider } from '../../harness-manifest'
import type { SessionId } from '@podium/model'
import type { ObservationCheckpointsRepository } from '../../store/observation-checkpoints'
import type { ObservationLeaseRecord, TerminalCandidateFacts } from '../../store/types'
import type { SessionObservationLeases } from './observation-leases'
import type { Session } from './session'

/**
 * Only the checkpoint operations this module needs, so it cannot reach the rest
 * of the store through a passed-in handle.
 *
 * DERIVED from the repository with `Pick` rather than hand-written. A restated
 * interface is a second copy of a signature that no compiler keeps in step: the
 * first draft of this file declared `get` as returning `| undefined` when the
 * repository returns `| null`, which type-checked against a hand-rolled shape
 * and would have compiled a subtly different contract into the seam.
 */
export type TerminalProofCheckpoints = Pick<
  ObservationCheckpointsRepository,
  'get' | 'getTerminalCandidate' | 'advanceGeneration'
>

export interface TerminalProofPorts {
  now(): number
  leases: SessionObservationLeases
  checkpoints: TerminalProofCheckpoints
  /** The live session map, read-only: the child-session scan needs every session. */
  sessions(): Iterable<Session>
  session(sessionId: SessionId): Session | undefined
  /** Messages still addressed to this session at proof time. */
  pendingForProof(
    sessionId: SessionId,
    atIso: string,
  ): {
    id: string
    status: string
    deliveredAt: string | null
    injectedAt?: string | null
    ackedBy: string | null
  }[]
  /** Whether the inbox is mid-drain for this session. */
  isDraining(sessionId: SessionId): boolean
  /** Whether the auto-continue controller is holding this session. */
  autoContinueActive(sessionId: SessionId): boolean
}

export class SessionTerminalProof {
  constructor(private readonly ports: TerminalProofPorts) {}

  /**
   * Allocate and durably store the observer lease before its control message is
   * sent. Shells and non-causal adapters intentionally have no lease.
   */
  fence(session: Session): ObservationLeaseRecord | undefined {
    const provider = harnessObservationProvider(session.agentKind)
    if (!provider) return undefined
    const lease = this.ports.checkpoints.advanceGeneration(
      session.sessionId,
      provider,
      session.resume?.value ?? null,
    )
    this.ports.leases.record(session.sessionId, lease)
    return lease
  }

  /**
   * Gather the facts that constitute a terminal proof, or null when the session
   * is not in a terminal-candidate state at all.
   *
   * Every list is SORTED before it is returned. That is load-bearing rather than
   * tidy: `hasValidProof` compares this structure to a durably stored one with
   * `JSON.stringify`, so a set that came back in a different order would read as
   * a different proof and silently refuse a legitimate hibernate.
   */
  facts(
    session: Session,
    lease: ObservationLeaseRecord,
    checkpoint = lease.checkpoint,
  ): TerminalCandidateFacts | null {
    const fence = checkpoint?.terminalFence
    if (!checkpoint || !fence || fence.closing) return null
    if (!['idle', 'errored', 'ended'].includes(checkpoint.turnState.phase)) return null
    const addressedMessages = this.ports
      .pendingForProof(session.sessionId, new Date(this.ports.now()).toISOString())
      .map((message) => ({
        id: message.id,
        status: message.status,
        deliveredAt: message.deliveredAt,
        injectedAt: message.injectedAt ?? null,
        ackedBy: message.ackedBy,
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
    const activeChildren = [...this.ports.sessions()]
      .filter(
        (child) =>
          isSpawnedBy(child.spawnedBy, { kind: 'session', id: session.sessionId }) &&
          (child.status === 'starting' ||
            child.status === 'live' ||
            child.status === 'reconnecting'),
      )
      .map((child) => ({
        sessionId: child.sessionId,
        status: child.status,
        activityCount: child.terminal.activityCount,
      }))
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    const activeWork = {
      nativeSubagentCount: checkpoint.turnState.nativeSubagentCount,
      nativeSubagentIds: (checkpoint.turnState.nativeSubagents ?? [])
        .map((child) => child.id)
        .sort(),
      awaitingSubagents: checkpoint.turnState.awaitingSubagents === true,
      childSessions: activeChildren,
      queueDrainActive: this.ports.isDraining(session.sessionId),
      draftPending: session.draftUpdatedAt !== undefined,
      draftVersion: session.draftUpdatedAt ?? null,
      offerPending: session.offer !== undefined,
    }
    return {
      schemaVersion: 1,
      sessionId: session.sessionId,
      terminalTransitionId: fence.transitionId,
      terminalTurnEpoch: fence.turnEpoch,
      provider: lease.provider,
      providerSessionId: lease.providerSessionId,
      bindingVersion: lease.bindingVersion,
      observerGeneration: lease.observationGeneration,
      providerCursor: checkpoint.providerCursor ?? fence.providerCursor,
      lastLiveReceiptAt: checkpoint.lastLiveReceiptAt,
      lastTransitionId: checkpoint.lastTransitionId,
      lastActiveAt: session.lastActiveAt,
      lastInputAtMs: session.terminal.lastInputAtMs,
      lastOutputAtMs: session.terminal.lastOutputAtMs,
      lastResumedAtMs: session.terminal.lastResumedAtMs,
      inputCount: session.terminal.inputCount,
      outputCount: session.terminal.outputCount,
      activityCount: session.terminal.activityCount,
      queuedInputCount: session.queuedMessageCount,
      pendingMessages: addressedMessages,
      autoContinueActive: this.ports.autoContinueActive(session.sessionId),
      activeWork,
      resumable: session.resume !== undefined,
      machineId: session.machineId,
    }
  }

  /** Whether gathered facts describe a session that may actually be parked. */
  consumable(facts: TerminalCandidateFacts): boolean {
    if (
      !facts.resumable ||
      facts.queuedInputCount !== 0 ||
      facts.pendingMessages.length !== 0 ||
      facts.autoContinueActive
    )
      return false
    const active = facts.activeWork
    return (
      active.nativeSubagentCount === 0 &&
      !active.awaitingSubagents &&
      active.childSessions.length === 0 &&
      !active.queueDrainActive &&
      !active.draftPending &&
      !active.offerPending
    )
  }

  hasValidProof(sessionId: SessionId): boolean {
    const session = this.ports.session(sessionId)
    const lease = this.ports.checkpoints.get(sessionId)
    if (!session || !lease || (session.status !== 'live' && session.status !== 'reconnecting'))
      return false
    const facts = this.facts(session, lease)
    const proof = this.ports.checkpoints.getTerminalCandidate(sessionId)
    return Boolean(
      facts &&
        proof?.confirmedAt &&
        !proof.consumedAt &&
        JSON.stringify(proof.facts) === JSON.stringify(facts) &&
        this.consumable(facts),
    )
  }

  proofMissing(sessionId: SessionId): boolean {
    const lease = this.ports.checkpoints.get(sessionId)
    return (
      lease?.checkpoint?.terminalFence == null ||
      this.ports.checkpoints.getTerminalCandidate(sessionId) == null
    )
  }
}
