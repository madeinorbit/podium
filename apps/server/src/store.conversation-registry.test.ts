import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'

// The conversation registry (docs/spec/conversation-registry.md §3.1): Podium ids
// are minted once, native ids map to them forever, and a live-roll attaches a new
// native file as the next SEGMENT of the same identity — never a new conversation.
describe('conversation registry store', () => {
  it('mints once and resolves the same podium id forever', () => {
    const store = new SessionStore(':memory:')
    const a = store.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'native-a',
      providerId: 'claude-code-jsonl',
    })
    expect(a).toMatch(/^conv_/)
    expect(
      store.conversations.ensureConversationIdentity({
        machineId: 'm1',
        nativeId: 'native-a',
        providerId: 'claude-code-jsonl',
      }),
    ).toBe(a)
    expect(store.conversations.conversationPodiumId('m1', 'native-a')).toBe(a)
    // Machine-scoped: the same native id on another machine is a different row.
    const other = store.conversations.ensureConversationIdentity({
      machineId: 'm2',
      nativeId: 'native-a',
      providerId: 'claude-code-jsonl',
    })
    expect(other).not.toBe(a)
  })

  it('live-roll links the new native id as segment 2 of the same identity', () => {
    const store = new SessionStore(':memory:')
    const podium = store.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'old-file',
      providerId: 'claude-code',
    })
    const linked = store.conversations.linkConversationSegment({
      machineId: 'm1',
      newNativeId: 'new-file',
      priorNativeId: 'old-file',
      providerId: 'claude-code',
    })
    expect(linked).toBe(podium)
    expect(store.conversations.conversationPodiumId('m1', 'new-file')).toBe(podium)
    // Rolling again chains a third segment onto the same identity.
    const linked2 = store.conversations.linkConversationSegment({
      machineId: 'm1',
      newNativeId: 'newest-file',
      priorNativeId: 'new-file',
      providerId: 'claude-code',
    })
    expect(linked2).toBe(podium)
    // Idempotent re-observation (e.g. after a restart) never re-links.
    expect(
      store.conversations.linkConversationSegment({
        machineId: 'm1',
        newNativeId: 'new-file',
        priorNativeId: 'old-file',
        providerId: 'claude-code',
      }),
    ).toBe(podium)
  })

  it('live-roll with an unseen prior mints the identity on the spot', () => {
    const store = new SessionStore(':memory:')
    const podium = store.conversations.linkConversationSegment({
      machineId: 'm1',
      newNativeId: 'roll-b',
      priorNativeId: 'roll-a',
      providerId: 'claude-code',
    })
    expect(store.conversations.conversationPodiumId('m1', 'roll-a')).toBe(podium)
    expect(store.conversations.conversationPodiumId('m1', 'roll-b')).toBe(podium)
  })

  it('records and refreshes transcript-path evidence on the segment', () => {
    const store = new SessionStore(':memory:')
    store.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'n1',
      providerId: 'p',
      path: '/home/u/.claude/projects/-old-spot/n1.jsonl',
    })
    expect(store.conversations.conversationSegmentPath('m1', 'n1')).toBe(
      '/home/u/.claude/projects/-old-spot/n1.jsonl',
    )
    // A later scan re-observes the same conversation: evidence refreshes in place.
    store.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'n1',
      providerId: 'p',
      path: '/home/u/.claude/projects/-new-spot/n1.jsonl',
    })
    expect(store.conversations.conversationSegmentPath('m1', 'n1')).toBe(
      '/home/u/.claude/projects/-new-spot/n1.jsonl',
    )
    expect(store.conversations.conversationSegmentPath('m1', 'unseen')).toBeUndefined()
  })

  it('fills a null parent later but never overwrites a set one', () => {
    const store = new SessionStore(':memory:')
    const child = store.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'child',
      providerId: 'p',
    })
    const parentA = store.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'parent-a',
      providerId: 'p',
    })
    // Parent learned on a later scan: fills the NULL.
    store.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'child',
      providerId: 'p',
      parentPodiumId: parentA,
    })
    const parentB = store.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'parent-b',
      providerId: 'p',
    })
    // A conflicting parent must NOT clobber (mis-parenting bias, spec §3.1).
    store.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'child',
      providerId: 'p',
      parentPodiumId: parentB,
    })
    const batch = store.conversations.conversationPodiumIds('m1', ['child', 'parent-a', 'parent-b'])
    expect(batch.get('child')).toBe(child)
    expect(batch.size).toBe(3)
  })

  it('boot repair nulls subagent paths poisoned onto other identities, keeps legitimate ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-conv-registry-'))
    const file = join(dir, 'store.db')
    const first = new SessionStore(file)
    // Poisoned by the pre-#94 discovery bug: a subagent transcript summarized
    // under the PARENT's native id clobbered the parent's segment path.
    first.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'parent-1',
      providerId: 'claude-code-jsonl',
      path: '/home/u/.claude/projects/-repo/parent-1/subagents/agent-x.jsonl',
    })
    // A subagent conversation's OWN row (post-fix): basename matches native id.
    first.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'agent-x',
      providerId: 'claude-code-jsonl',
      path: '/home/u/.claude/projects/-repo/parent-1/subagents/agent-x.jsonl',
    })
    // A normal main-transcript row: untouched.
    first.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'parent-2',
      providerId: 'claude-code-jsonl',
      path: '/home/u/.claude/projects/-repo/parent-2.jsonl',
    })
    first.close()
    const second = new SessionStore(file)
    expect(second.conversations.conversationSegmentPath('m1', 'parent-1')).toBeUndefined()
    expect(second.conversations.conversationSegmentPath('m1', 'agent-x')).toBe(
      '/home/u/.claude/projects/-repo/parent-1/subagents/agent-x.jsonl',
    )
    expect(second.conversations.conversationSegmentPath('m1', 'parent-2')).toBe(
      '/home/u/.claude/projects/-repo/parent-2.jsonl',
    )
    second.close()
  })
})
