// @vitest-environment happy-dom
import { asSessionId, type SessionMeta, type TranscriptItem } from '@podium/model'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useHandoffTranscript } from './use-handoff-transcript'

const harness = vi.hoisted(() => {
  const read = vi.fn()
  const put = vi.fn()
  let cached: { items: TranscriptItem[] } | undefined
  return {
    read,
    put,
    get cached() {
      return cached
    },
    set cached(value: { items: TranscriptItem[] } | undefined) {
      cached = value
    },
    store: {
      trpc: { sessions: { transcriptRead: { query: read } } },
      replica: {
        transcriptWindow: () => cached,
        putTranscriptWindow: put,
      },
    },
  }
})

vi.mock('./store', () => ({
  useStoreSelector: (select: (store: Record<string, unknown>) => unknown) => select(harness.store),
}))

const session = (id: string, stamp = '2026-09-01T10:00:00.000Z'): SessionMeta =>
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
  }) as SessionMeta

const item = (id: string, role: TranscriptItem['role'], text: string): TranscriptItem => ({
  id,
  role,
  text,
})

beforeEach(() => {
  harness.read.mockReset()
  harness.put.mockReset()
  harness.cached = undefined
})

describe('useHandoffTranscript', () => {
  it('does no transcript work while inactive', () => {
    const { result } = renderHook(() => useHandoffTranscript(false, [session('hook-inactive')]))
    expect(result.current.status).toBe('empty')
    expect(harness.read).not.toHaveBeenCalled()
  })

  it('pages backward to the operator prompt and pairs the newer final answer', async () => {
    harness.read
      .mockResolvedValueOnce({
        items: [
          { ...item('answer', 'assistant', 'Finished.'), answer: true, cursor: 'answer-cursor' },
        ],
        hasMore: true,
        head: 'answer-cursor',
      })
      .mockResolvedValueOnce({
        items: [{ ...item('prompt', 'user', 'Status?'), cursor: 'prompt-cursor' }],
        hasMore: false,
        head: 'prompt-cursor',
      })

    const { result } = renderHook(() =>
      useHandoffTranscript(true, [session('hook-paged', '2026-09-01T10:01:00.000Z')]),
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.pair?.prompt.anchor.itemKey).toBe('prompt-cursor')
    expect(result.current.pair?.answer?.anchor.itemKey).toBe('answer-cursor')
    expect(harness.read).toHaveBeenNthCalledWith(2, {
      sessionId: 'hook-paged',
      anchor: 'answer-cursor',
      direction: 'before',
      limit: 400,
    })
  })

  it('seeds from replica data, retries a failed read, and writes the refreshed tail', async () => {
    harness.cached = { items: [item('seed-prompt', 'user', 'Cached question')] }
    harness.read.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
      items: [
        item('fresh-prompt', 'user', 'Fresh question'),
        { ...item('fresh-answer', 'assistant', 'Fresh answer'), answer: true },
      ],
      hasMore: false,
    })

    const { result } = renderHook(() =>
      useHandoffTranscript(true, [session('hook-retry', '2026-09-01T10:02:00.000Z')]),
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.pair?.prompt.item.id).toBe('seed-prompt')

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.pair?.prompt.item.id).toBe('fresh-prompt'))
    expect(harness.put).toHaveBeenCalledWith(
      'hook-retry',
      expect.arrayContaining([expect.objectContaining({ id: 'fresh-answer' })]),
    )
  })
})
