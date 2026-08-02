import {
  type OnlineEvents,
  OUTBOX_LS_KEY,
  Outbox,
  type OutboxInit,
  type OutboxStorage,
} from '@podium/client-core/outbox'

export {
  type OnlineEvents,
  OUTBOX_LS_KEY,
  Outbox,
  type OutboxEntry,
  type OutboxExecutors,
  type OutboxInit,
  type OutboxStorage,
  parseOutboxEntries,
} from '@podium/client-core/outbox'

function browserOnlineEvents(): OnlineEvents | undefined {
  if (typeof window === 'undefined') return undefined
  return {
    add: (cb) => window.addEventListener('online', cb),
    remove: (cb) => window.removeEventListener('online', cb),
  }
}

function browserIsOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

/**
 * Web outbox factory. Storage MUST be the replica's outbox adapter
 * (`replica.outboxStorage()`) — direct localStorage access is not permitted
 * outside ui-state and the replica persistence adapter (POD-329).
 */
export function createOutbox<M extends Record<string, object>>(
  init: Omit<OutboxInit<M>, 'onlineEvents'> & {
    storage: OutboxStorage
    onlineEvents?: OnlineEvents
  },
): Outbox<M> {
  return new Outbox({
    ...init,
    isOnline: init.isOnline ?? browserIsOnline,
    onlineEvents: init.onlineEvents ?? browserOnlineEvents(),
  })
}
