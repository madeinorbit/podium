import type { SessionId, UserId } from '@podium/model'
import type { ControlMessage, DaemonMessage } from '@podium/protocol'
import { harnessRequiresExclusiveInteractiveResume } from '../../harness-manifest'
import type { SessionStore } from '../../store'
import type { Session } from './session'

type ResumeObservation = Extract<DaemonMessage, { type: 'sessionResumeRef' }>

interface SessionOwnership {
  owner: UserId
  grants: string[]
}

export interface SessionBindingReceiptsDeps {
  store: SessionStore
  now(): number
  sessions(): Iterable<Session>
  session(sessionId: SessionId): Session | undefined
  sessionOwner(sessionId: SessionId): SessionOwnership | undefined
  persist(session: Session): void
  broadcastSessions(): void
  toMachine(machineId: string, message: ControlMessage): void
}

/**
 * Server-side SessionBinding observation and receipt acknowledgement seam.
 *
 * Native resume references are binding observations, not lifecycle transitions
 * and never authority. The daemon's machine principal gates the observation;
 * the durable session owner scopes the acknowledgement.
 */
export class SessionBindingReceipts {
  /** Provenance for the current scalar projection during this server lifetime.
   * Absence is deliberately treated as exact after restart: losing provenance
   * must make arbitration conservative, never destructive. */
  private readonly projectedConfidence = new WeakMap<Session, 'exact' | 'heuristic'>()

  constructor(private readonly deps: SessionBindingReceiptsDeps) {}

  observeResumeRef(machineId: string, message: ResumeObservation): void {
    const session = this.deps.session(message.sessionId)
    if (!session) return
    // A daemon may bind only sessions owned by its authenticated machine.
    if (session.machineId !== machineId) {
      console.warn(
        `[podium] ignored resume binding for ${message.sessionId} from non-owner machine ${machineId}`,
      )
      return
    }
    const confidence = message.confidence ?? 'heuristic'
    const conflicts =
      harnessRequiresExclusiveInteractiveResume(session.agentKind) && !session.headless
        ? [...this.deps.sessions()].filter(
            (other) =>
              other.sessionId !== session.sessionId &&
              ['starting', 'live', 'reconnecting'].includes(other.status) &&
              !other.headless &&
              harnessRequiresExclusiveInteractiveResume(other.agentKind) &&
              other.resume?.kind === message.resume.kind &&
              other.resume.value === message.resume.value,
          )
        : []
    if (conflicts.length > 0) {
      if (confidence !== 'exact') {
        console.warn(
          `[podium] ignored heuristic native identity collision ${message.resume.value} for ${session.sessionId}`,
        )
        return
      }
      // Missing provenance means a durable projection survived a server restart;
      // treat it as exact rather than destructively guessing it was heuristic.
      const exactConflicts = conflicts.filter(
        (conflict) => this.projectedConfidence.get(conflict) !== 'heuristic',
      )
      if (exactConflicts.length > 0) {
        const participants = [session, ...exactConflicts].sort((a, b) =>
          a.sessionId.localeCompare(b.sessionId),
        )
        const participantIds = participants.map((participant) => participant.sessionId)
        const conflictId = `resume-conflict:${message.resume.kind}:${message.resume.value}:${participantIds.join(',')}`
        const observedAt = new Date(this.deps.now()).toISOString()
        for (const participant of participants) {
          this.deps.toMachine(participant.machineId, {
            type: 'sessionResumeRefConflict',
            sessionId: participant.sessionId,
            resume: message.resume,
            conflictId,
            conflictingSessionIds: participantIds.filter((id) => id !== participant.sessionId),
            observedAt,
          })
        }
        console.warn(
          `[podium] exact native identity conflict ${message.resume.value} across ${participantIds.join(', ')}`,
        )
        return
      }
      for (const conflict of conflicts) {
        conflict.resume = undefined
        conflict.conversationPodiumId = undefined
        this.projectedConfidence.delete(conflict)
        this.deps.persist(conflict)
      }
      this.deps.broadcastSessions()
    }

    if (
      session.resume?.kind !== message.resume.kind ||
      session.resume?.value !== message.resume.value
    ) {
      const prior = session.resume?.value
      session.resume = message.resume
      session.conversationPodiumId = prior
        ? this.deps.store.conversations.linkConversationSegment({
            machineId: session.machineId,
            newNativeId: message.resume.value,
            priorNativeId: prior,
            providerId: session.agentKind,
          })
        : this.deps.store.conversations.ensureConversationIdentity({
            machineId: session.machineId,
            nativeId: message.resume.value,
            providerId: session.agentKind,
          })
      this.deps.persist(session)
      this.deps.broadcastSessions()
    }
    this.projectedConfidence.set(session, confidence)

    // Ack only after the exact mapping is already in durable server state.
    if (message.ackRequested && message.confidence === 'exact') {
      const owner = this.deps.sessionOwner(message.sessionId)?.owner
      if (!owner) return
      this.deps.toMachine(machineId, {
        type: 'sessionResumeRefAck',
        sessionId: message.sessionId,
        resume: message.resume,
        ownerId: owner,
      })
    }
  }
}
