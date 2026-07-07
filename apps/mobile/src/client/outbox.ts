import {
  type OnlineEvents,
  Outbox,
  type OutboxInit,
  type OutboxStorage,
  parseOutboxEntries,
} from '@podium/client-core/outbox'

export const MOBILE_OUTBOX_LS_KEY = 'podium.mobile.outbox.v1'

let nativeFallbackRaw: string | null = null

export function mobileStorageBacking(key = MOBILE_OUTBOX_LS_KEY): OutboxStorage {
  return {
    load: () => {
      if (typeof localStorage === 'undefined') return parseOutboxEntries(nativeFallbackRaw)
      try {
        return parseOutboxEntries(localStorage.getItem(key))
      } catch {
        return []
      }
    },
    save: (entries) => {
      const raw = JSON.stringify(entries)
      if (typeof localStorage === 'undefined') {
        nativeFallbackRaw = raw
        return
      }
      try {
        localStorage.setItem(key, raw)
      } catch {
        return
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

export function createMobileOutbox<M extends Record<string, object>>(
  init: Omit<OutboxInit<M>, 'storage' | 'onlineEvents'> & {
    storage?: OutboxStorage
    onlineEvents?: OnlineEvents
  },
): Outbox<M> {
  return new Outbox({
    ...init,
    storage: init.storage ?? mobileStorageBacking(),
    onlineEvents: init.onlineEvents ?? browserOnlineEvents(),
  })
}
