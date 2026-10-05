import { ConversationCache, DraftStore, type ConversationCacheOptions } from '@podium/client-core/conversation'
import type { SessionId } from '@podium/model'
import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import type { MessageRecordWire } from '@podium/model'
import { useRuntimeSelector as selectMockSnapshot } from '@/app/store'

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

const keyedHandle = withKeyedInputs({
  getSnapshot: (): FakeSnapshot => {
    // These suites also replace the web store. Keep the stable transports and UI
    // writer on that same owner while preserving this external-store snapshot's
    // identity and independently controlled message/outbox rows.
    for (const key of ['uiState', 'trpc', 'hub', 'httpOrigin', 'replica', 'setSessionDraft', 'sendChat', 'discardChat', 'dismissOffer', 'setPanelMode', 'getUserFocus', 'clearAttachedSession', 'openFile', 'tldrSession', 'clearTranscriptReveal', 'attachedSessionId'] as const) {
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
})

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
  conversations?.dispose(); conversations = undefined
  drafts?.dispose(); drafts = undefined
  snapshot = { issues: [], messageRecords: [], outboxDeadLetters: [], chatSendsFor: () => [] }
}

let conversations: ConversationCache | undefined
let drafts: DraftStore | undefined
export const fakeStoreHandle = Object.defineProperties(keyedHandle, {
  drafts: { get() {
    if (!drafts) {
      const state = selectMockSnapshot(state => state)
      drafts = new DraftStore({
        storage: { get: () => null, set: () => {} },
        hub: { on: () => () => {}, sendDraftEdit: () => {}, connectionHealth: () => ({ status: 'ok' }) } as never,
        onChange: (id, text) => selectMockSnapshot(state => state.setSessionDraft)?.(id, text),
      })
      for (const [id, text] of Object.entries((state as unknown as { drafts?: Record<string, string> }).drafts ?? {})) drafts.values.set(id as SessionId, text)
    }
    return drafts
  } },
  ownConversations: { value: (options: ConversationCacheOptions) => conversations ??= new ConversationCache(options) },
}) as typeof keyedHandle & { drafts: DraftStore; ownConversations(options: ConversationCacheOptions): ConversationCache }
