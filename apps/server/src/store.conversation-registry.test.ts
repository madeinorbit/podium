import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'

// The conversation registry (docs/spec/conversation-registry.md §3.1): Podium ids
// are minted once, native ids map to them forever, and a live-roll attaches a new
// native file as the next SEGMENT of the same identity — never a new conversation.
describe('conversation registry store', () => {
  it('mints once and resolves the same podium id forever', () => {
    const store = new SessionStore(':memory:')
    const a = store.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'native-a',
      providerId: 'claude-code-jsonl',
    })
    expect(a).toMatch(/^conv_/)
    expect(
      store.ensureConversationIdentity({
        machineId: 'm1',
        nativeId: 'native-a',
        providerId: 'claude-code-jsonl',
      }),
    ).toBe(a)
    expect(store.conversationPodiumId('m1', 'native-a')).toBe(a)
    // Machine-scoped: the same native id on another machine is a different row.
    const other = store.ensureConversationIdentity({
      machineId: 'm2',
      nativeId: 'native-a',
      providerId: 'claude-code-jsonl',
    })
    expect(other).not.toBe(a)
  })

  it('live-roll links the new native id as segment 2 of the same identity', () => {
    const store = new SessionStore(':memory:')
    const podium = store.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'old-file',
      providerId: 'claude-code',
    })
    const linked = store.linkConversationSegment({
      machineId: 'm1',
      newNativeId: 'new-file',
      priorNativeId: 'old-file',
      providerId: 'claude-code',
    })
    expect(linked).toBe(podium)
    expect(store.conversationPodiumId('m1', 'new-file')).toBe(podium)
    // Rolling again chains a third segment onto the same identity.
    const linked2 = store.linkConversationSegment({
      machineId: 'm1',
      newNativeId: 'newest-file',
      priorNativeId: 'new-file',
      providerId: 'claude-code',
    })
    expect(linked2).toBe(podium)
    // Idempotent re-observation (e.g. after a restart) never re-links.
    expect(
      store.linkConversationSegment({
        machineId: 'm1',
        newNativeId: 'new-file',
        priorNativeId: 'old-file',
        providerId: 'claude-code',
      }),
    ).toBe(podium)
  })

  it('live-roll with an unseen prior mints the identity on the spot', () => {
    const store = new SessionStore(':memory:')
    const podium = store.linkConversationSegment({
      machineId: 'm1',
      newNativeId: 'roll-b',
      priorNativeId: 'roll-a',
      providerId: 'claude-code',
    })
    expect(store.conversationPodiumId('m1', 'roll-a')).toBe(podium)
    expect(store.conversationPodiumId('m1', 'roll-b')).toBe(podium)
  })

  it('fills a null parent later but never overwrites a set one', () => {
    const store = new SessionStore(':memory:')
    const child = store.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'child',
      providerId: 'p',
    })
    const parentA = store.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'parent-a',
      providerId: 'p',
    })
    // Parent learned on a later scan: fills the NULL.
    store.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'child',
      providerId: 'p',
      parentPodiumId: parentA,
    })
    const parentB = store.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'parent-b',
      providerId: 'p',
    })
    // A conflicting parent must NOT clobber (mis-parenting bias, spec §3.1).
    store.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'child',
      providerId: 'p',
      parentPodiumId: parentB,
    })
    const batch = store.conversationPodiumIds('m1', ['child', 'parent-a', 'parent-b'])
    expect(batch.get('child')).toBe(child)
    expect(batch.size).toBe(3)
  })
})
