import {
  type OnlineEvents,
  OUTBOX_LS_KEY,
  Outbox,
  type OutboxInit,
  type OutboxStorage,
  parseOutboxEntries,
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

/** Guarded like store.tsx's lsGet/lsSet — localStorage throws in private-mode/SSR. */
export function localStorageBacking(key = OUTBOX_LS_KEY): OutboxStorage {
  return {
    load: () => {
      try {
        return parseOutboxEntries(localStorage.getItem(key))
      } catch {
        return []
      }
    },
    save: (entries) => {
      try {
        localStorage.setItem(key, JSON.stringify(entries))
      } catch {
        // storage unavailable — durability is best-effort
      }
    },
  }
}

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

export function createOutbox<M extends Record<string, object>>(
  init: Omit<OutboxInit<M>, 'storage' | 'onlineEvents'> & {
    storage?: OutboxStorage
    onlineEvents?: OnlineEvents
  },
): Outbox<M> {
  return new Outbox({
    ...init,
    storage: init.storage ?? localStorageBacking(),
    isOnline: init.isOnline ?? browserIsOnline,
    onlineEvents: init.onlineEvents ?? browserOnlineEvents(),
  })
}
