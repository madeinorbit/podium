import type { MachineId, ResumeRef, SessionId, UserId } from '@podium/model'
import type { HandoffBindingTransfer } from '@podium/protocol'
import type {
  BindingAdoptObservation,
  BindingStore,
  SessionBindingRecord,
  SessionBindingTransition,
  SessionBindingTransitionOutcome,
} from './binding-store'

/**
 * The only lifecycle surface exposed to observers and control handlers.
 * Persistence, alias layout, and delegation field names remain private to the
 * binding module so consumers cannot recreate partial transition logic.
 */
export class SessionBinding {
  constructor(private readonly store: BindingStore) {}

  transition(input: SessionBindingTransition): Promise<SessionBindingTransitionOutcome> {
    return this.store.transition(input)
  }

  read(sessionId: SessionId): Promise<SessionBindingRecord | null> {
    return this.store.read(sessionId)
  }

  forOwner(owner: UserId): Promise<SessionBindingRecord[]> {
    return this.store.bindingsForOwner(owner)
  }

  /** Serialize the immutable delegation inside the binding boundary. */
  adoptTransfer(
    binding: SessionBindingRecord,
    input: { transferId: string; fromMachineId: MachineId; toMachineId: MachineId },
  ): HandoffBindingTransfer | null {
    const delegation = this.store.currentDelegation(binding)
    if (!delegation) return null
    return {
      transferId: input.transferId,
      sessionId: binding.sessionId,
      agentKind: binding.agentKind,
      fromMachineId: input.fromMachineId,
      toMachineId: input.toMachineId,
      observationGeneration: binding.observationGeneration + 1,
      delegation: {
        actor: delegation.actor,
        onBehalfOf: delegation.onBehalfOf,
        grantedScope: delegation.grantedScope,
        parentBindingId: delegation.parentBindingId,
      },
    }
  }

  /** Re-observe imported native artifacts without exposing binding field aliases. */
  adoptObservations(input: {
    resume: ResumeRef
    nativeArtifactPath: string
    cwd: string
    worktreePin: string
  }): BindingAdoptObservation[] {
    const nativeArtifactChannel =
      input.resume.kind === 'codex-thread' ? 'rollout-path' : 'transcript-path'
    return [
      { channel: 'resume-ref', value: input.resume.value, nativeKind: input.resume.kind },
      { channel: nativeArtifactChannel, value: input.nativeArtifactPath },
      { channel: 'cwd', value: input.cwd },
      { channel: 'worktree-pin', value: input.worktreePin },
    ]
  }
}
