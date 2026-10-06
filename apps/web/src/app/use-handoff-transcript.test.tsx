import type { SessionView } from '@podium/client-core/session-values'
import { TranscriptLog } from '@podium/client-core/conversation'
// @vitest-environment happy-dom
import { asSessionId, type SessionId, type TranscriptItem } from '@podium/model'
import type { TranscriptPage } from '@podium/client-core/transcript'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useHandoffTranscript } from './use-handoff-transcript'

interface Shell {
  conversation: { transcript: TranscriptLog; start: () => Promise<void> }
  read: ReturnType<typeof vi.fn>
  setPage: (page: TranscriptPage) => void
  started: boolean
}

const harness = vi.hoisted(() => {
  const shells = new Map<string, Shell>()
  return { shells, pool: {} }
})

vi.mock('@podium/client-core/react', () => ({
  useStoreHandle: () => ({ get access() { return {} } }),
  useConversation: (
    sessionId: SessionId | undefined,
    _factory: unknown,
    options?: { enabled?: boolean },
  ) => {
    if (sessionId === undefined || options?.enabled === false) return undefined
    const shell = harness.shells.get(sessionId)
    if (shell && !shell.started) {
      shell.started = true
      void shell.conversation.start()
    }
    return shell?.conversation
  },
}))

vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: () => harness.pool,
}))

vi.mock('@/features/chat/use-conversation', () => ({
  createWebConversation: vi.fn(),
}))

const at = (offset: number) =>
  Buffer.from(JSON.stringify(['file', offset, `id${offset}`, 0])).toString('base64url')

function shell(sessionId: string, first: TranscriptPage): Shell {
  let page = first
  const read = vi.fn(async () => page)
  const log = new TranscriptLog({
    sessionId: asSessionId(sessionId),
    source: { read, subscribe: () => () => {} },
    retainHistory: () => true,
  })
  const entry: Shell = {
    conversation: { transcript: log, start: () => log.start() },
    read,
    setPage: (next) => {
      page = next
    },
    started: false,
  }
  harness.shells.set(sessionId, entry)
  return entry
}

const session = (id: string, stamp = '2026-09-01T10:00:00.000Z'): SessionView =>
  ({
    sessionId: asSessionId(id),
    agentKind: 'codex',
    cwd: '/repo',
    status: 'live',
    archived: false,
    createdAt: '2026-09-01T09:00:00.000Z',
    lastInputAt: stamp,
    lastActiveAt: stamp,
    transcriptAvailable: true,
  }) as SessionView

const item = (id: string, role: TranscriptItem['role'], text: string, offset: number): TranscriptItem => ({
  id,
  role,
  text,
  cursor: at(offset),
})

beforeEach(() => {
  for (const entry of harness.shells.values()) entry.conversation.transcript.dispose()
  harness.shells.clear()
})

describe('useHandoffTranscript', () => {
  it('does no transcript work while inactive', () => {
    shell('hook-inactive', { items: [], hasMore: false })
    const { result } = renderHook(() => useHandoffTranscript(false, [session('hook-inactive')]))
    expect(result.current.status).toBe('empty')
    expect(harness.shells.get('hook-inactive')!.read).not.toHaveBeenCalled()
  })

  it('pages the shared log to the operator prompt and pairs the final answer', async () => {
    const entry = shell('hook-paged', {
      items: [item('answer', 'assistant', 'Finished.', 30)],
      head: at(30),
      tail: at(30),
      hasMore: true,
    })
    const { result } = renderHook(() =>
      useHandoffTranscript(true, [session('hook-paged', '2026-09-01T10:01:00.000Z')]),
    )
    // Stage the older page synchronously: the shared log reads it on a
    // microtask the hook has not reached yet.
    entry.setPage({
      items: [
        item('prompt', 'user', 'Status?', 10),
        item('context', 'assistant', 'context', 20),
      ],
      head: at(10),
      tail: at(20),
      hasMore: false,
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.pair?.prompt.item.id).toBe('prompt')
    expect(result.current.pair?.answer?.item.id).toBe('answer')
    expect(result.current.pair?.prompt.anchor.itemKey).toBe(at(10))
    expect(result.current.pair?.answer?.anchor.itemKey).toBe(at(30))
    expect(entry.read).toHaveBeenNthCalledWith(2, {
      sessionId: 'hook-paged',
      anchor: at(30),
      direction: 'before',
      limit: 400,
    })
  })

  it('reports an older-page failure and retries into a ready pair', async () => {
    const entry = shell('hook-retry', {
      items: [item('answer', 'assistant', 'Finished.', 30)],
      head: at(30),
      tail: at(30),
      hasMore: true,
    })
    const { result } = renderHook(() =>
      useHandoffTranscript(true, [session('hook-retry', '2026-09-01T10:02:00.000Z')]),
    )
    // Fail the hook's older-page read, not the log's initial refresh: queue
    // synchronously so it lands on the second source call.
    entry.read.mockRejectedValueOnce(new Error('offline'))
    await waitFor(() => expect(result.current.status).toBe('error'))
    entry.setPage({
      items: [
        item('prompt', 'user', 'Fresh question', 10),
        item('answer', 'assistant', 'Fresh answer', 30),
      ],
      head: at(10),
      tail: at(30),
      hasMore: false,
    })
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.pair?.prompt.item.id).toBe('prompt')
  })

  it('follows a new message on the shared log', async () => {
    const entry = shell('hook-live', {
      items: [
        item('prompt', 'user', 'Status?', 10),
        item('reply-1', 'assistant', 'first', 20),
      ],
      head: at(10),
      tail: at(20),
      hasMore: false,
    })
    const { result } = renderHook(() =>
      useHandoffTranscript(true, [session('hook-live', '2026-09-01T10:03:00.000Z')]),
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.pair?.answer?.item.id).toBe('reply-1')
    expect(result.current.pair?.answer?.legacy).toBe(true)
    act(() => {
      entry.conversation.transcript.merge([item('reply-2', 'assistant', 'latest', 40)])
    })
    await waitFor(() => expect(result.current.pair?.answer?.item.id).toBe('reply-2'))
  })
})
