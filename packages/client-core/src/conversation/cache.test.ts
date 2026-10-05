import { asSessionId, type SessionId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationCache, DESKTOP_WARM_CONVERSATIONS, PHONE_WARM_CONVERSATIONS } from './cache'
import { DraftStore } from './draft-store'
import { Conversation } from './model'

const a = asSessionId('a'),
  b = asSessionId('b'),
  c = asSessionId('c')
const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

function fixture(warmLimit = 3) {
  const drafts = new DraftStore({
    storage: { get: () => null, set: vi.fn() },
    hub: {
      on: () => () => {},
      sendDraftEdit: vi.fn(),
      connectionHealth: () => ({ status: 'ok', rttMs: null, since: 0 }),
    },
  })
  const live = new Set<SessionId>(),
    created = new Map<SessionId, number>(),
    unsubscribed = vi.fn()
  const cache = new ConversationCache({
    warmLimit,
    create: (sessionId) => {
      created.set(sessionId, (created.get(sessionId) ?? 0) + 1)
      return new Conversation({
        sessionId,
        drafts,
        readSession: () => ({ status: 'live' }),
        transcript: {
          source: {
            read: async () => ({
              items: [{ id: 'first', role: 'assistant', text: 'first' }],
              hasMore: false,
            }),
            subscribe: () => {
              live.add(sessionId)
              return () => {
                live.delete(sessionId)
                unsubscribed(sessionId)
              }
            },
          },
        },
        sends: { createDeliveryId: () => 'send', deliver: async () => {} },
      })
    },
  })
  return {
    cache,
    drafts,
    live,
    created,
    unsubscribed,
    dispose: () => {
      cache.dispose()
      drafts.dispose()
    },
  }
}

afterEach(() => vi.useRealTimers())

describe('ConversationCache live resource ownership', () => {
  it('reuses an object and its one stream after release within the warm budget', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const first = f.cache.acquire(a)
    await settle()
    first.release()
    await settle()
    const next = f.cache.acquire(a)
    await settle()
    expect(next.conversation).toBe(first.conversation)
    expect(f.created.get(a)).toBe(1)
    expect(f.live.has(a)).toBe(true)
    expect(f.unsubscribed).not.toHaveBeenCalled()
    next.release()
    f.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('evicts the least recently used warm object, unsubscribes its stream and clears its heartbeat', async () => {
    vi.useFakeTimers()
    const f = fixture(1)
    const first = f.cache.acquire(a)
    await settle()
    first.release()
    await settle()
    const second = f.cache.acquire(b)
    await settle()
    expect(vi.getTimerCount()).toBe(2)
    second.release()
    expect(f.unsubscribed).not.toHaveBeenCalled()
    await settle()
    expect(f.live.has(a)).toBe(false)
    expect(f.live.has(b)).toBe(true)
    expect(f.unsubscribed).toHaveBeenCalledExactlyOnceWith(a)
    expect(vi.getTimerCount()).toBe(1)
    const newA = f.cache.acquire(a)
    await settle()
    expect(newA.conversation).not.toBe(first.conversation)
    expect(f.created.get(a)).toBe(2)
    newA.release()
    f.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a StrictMode cleanup/setup cycle keeps one stream, even with a zero warm budget', async () => {
    vi.useFakeTimers()
    const f = fixture(0)
    const first = f.cache.acquire(a)
    await settle()
    first.release()
    const remount = f.cache.acquire(a)
    await settle()
    expect(remount.conversation).toBe(first.conversation)
    expect(f.created.get(a)).toBe(1)
    expect(f.unsubscribed).not.toHaveBeenCalled()
    expect(f.live.size).toBe(1)
    remount.release()
    await settle()
    expect(f.live.size).toBe(0)
    f.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refcounts multiple readers and makes release idempotent', async () => {
    const f = fixture(0),
      first = f.cache.acquire(a),
      second = f.cache.acquire(a)
    await settle()
    first.release()
    first.release()
    await settle()
    expect(f.live.size).toBe(1)
    second.release()
    await settle()
    expect(f.live.size).toBe(0)
    f.dispose()
  })

  it('sign-out disposes active and warm conversations and rejects reacquisition', async () => {
    vi.useFakeTimers()
    const f = fixture(2)
    const first = f.cache.acquire(a),
      second = f.cache.acquire(b),
      third = f.cache.acquire(c)
    await settle()
    first.release()
    await settle()
    expect(f.live.size).toBe(3)
    f.cache.dispose()
    second.release()
    third.release()
    await settle()
    expect(f.live.size).toBe(0)
    expect(f.unsubscribed).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
    expect(() => f.cache.acquire(a)).toThrow('disposed')
    f.dispose()
  })

  it('matches the current warm-panel budgets', () => {
    expect(DESKTOP_WARM_CONVERSATIONS).toBe(3)
    expect(PHONE_WARM_CONVERSATIONS).toBe(2)
  })
})
