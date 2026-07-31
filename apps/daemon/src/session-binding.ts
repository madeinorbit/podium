import type { SessionId, UserId } from '@podium/model'
import type {
  BindingDelegationObservation,
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

  delegation(binding: SessionBindingRecord): BindingDelegationObservation | null {
    return this.store.currentDelegation(binding)
  }
}
