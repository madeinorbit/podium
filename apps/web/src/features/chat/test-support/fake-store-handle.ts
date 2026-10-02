import { useStoreSelector as selectMockSnapshot } from '@/app/store'
import type { MessageRecordWire } from '@podium/model'

/**
 * THE STORE HANDLE provider-free ChatView suites render against. Real enough
 * for what the chat reads off it (POD-4764): the synced message records and
 * the outbox's held chat sends, with `subscribe` so a test can move them and
 * watch the bubbles follow.
 */
interface FakeSnapshot {
  issues: unknown[]
  messageRecords: MessageRecordWire[]
  outboxDeadLetters: unknown[]
  chatSendsFor: (sessionId: never) => unknown[]
}

const listeners = new Set<() => void>()
let snapshot: FakeSnapshot = {
  issues: [],
  messageRecords: [],
  outboxDeadLetters: [],
  chatSendsFor: () => [],
}

export const fakeStoreHandle = {
  getSnapshot: (): FakeSnapshot => {
    // These suites also replace the web store. Keep the stable transports and UI
    // writer on that same owner while preserving this external-store snapshot's
    // identity and independently controlled message/outbox rows.
    for (const key of ['uiState', 'trpc', 'hub', 'httpOrigin', 'replica'] as const) {
      if (!Object.getOwnPropertyDescriptor(snapshot, key)) {
        Object.defineProperty(snapshot, key, {
          enumerable: true,
          get: () => selectMockSnapshot((state) => state[key]),
        })
      }
    }
    return snapshot
  },
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

/** Move the fake store; every subscriber hears it. */
export function setFakeStore(patch: Partial<FakeSnapshot>): void {
  snapshot = {
    issues: snapshot.issues,
    messageRecords: snapshot.messageRecords,
    outboxDeadLetters: snapshot.outboxDeadLetters,
    chatSendsFor: snapshot.chatSendsFor,
    ...patch,
  }
  for (const listener of listeners) listener()
}

/** Back to empty, between tests. */
export function resetFakeStore(): void {
  snapshot = { issues: [], messageRecords: [], outboxDeadLetters: [], chatSendsFor: () => [] }
}
