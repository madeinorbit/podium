import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ConversationDeltaWire, createActiveRefresh } from './active-refresh.js'

const emptyDelta: ConversationDeltaWire = { changed: [], removed: [], diagnostics: [] }

describe('createActiveRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces many dirty marks within the window into ONE refresh for the union of paths', async () => {
    const runPathsRefresh = vi.fn(async (_paths: string[]) => emptyDelta)
    const refresh = createActiveRefresh({
      runPathsRefresh,
      publish: vi.fn(),
      onError: vi.fn(),
      windowMs: 1_000,
    })

    // Three marks across two distinct files, all inside the 1s window.
    refresh.markConversationDirty('/a/conv-1.jsonl')
    refresh.markConversationDirty('/a/conv-2.jsonl')
    refresh.markConversationDirty('/a/conv-1.jsonl')

    // Nothing fires before the window elapses.
    expect(runPathsRefresh).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)

    // Exactly ONE job, for the de-duplicated UNION of the dirty paths.
    expect(runPathsRefresh).toHaveBeenCalledTimes(1)
    expect([...runPathsRefresh.mock.calls[0]![0]].sort()).toEqual([
      '/a/conv-1.jsonl',
      '/a/conv-2.jsonl',
    ])
  })

  it('starts a fresh window after a flush (marks in a later window flush separately)', async () => {
    const runPathsRefresh = vi.fn(async (_paths: string[]) => emptyDelta)
    const refresh = createActiveRefresh({
      runPathsRefresh,
      publish: vi.fn(),
      onError: vi.fn(),
      windowMs: 1_000,
    })

    refresh.markConversationDirty('/a/one.jsonl')
    await vi.advanceTimersByTimeAsync(1_000)
    refresh.markConversationDirty('/a/two.jsonl')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(runPathsRefresh).toHaveBeenCalledTimes(2)
    expect(runPathsRefresh.mock.calls[0]![0]).toEqual(['/a/one.jsonl'])
    expect(runPathsRefresh.mock.calls[1]![0]).toEqual(['/a/two.jsonl'])
  })

  it('publishes a non-empty delta and skips publishing an empty one', async () => {
    const nonEmpty: ConversationDeltaWire = {
      changed: [{ id: 'conv-1' } as ConversationDeltaWire['changed'][number]],
      removed: [],
      diagnostics: [],
    }
    const runPathsRefresh = vi
      .fn<(paths: string[]) => Promise<ConversationDeltaWire>>()
      .mockResolvedValueOnce(nonEmpty)
      .mockResolvedValueOnce(emptyDelta)
    const publish = vi.fn()
    const refresh = createActiveRefresh({ runPathsRefresh, publish, onError: vi.fn() })

    refresh.markConversationDirty('/a/conv-1.jsonl')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(nonEmpty)

    refresh.markConversationDirty('/a/conv-1.jsonl')
    await vi.advanceTimersByTimeAsync(1_000)
    // Empty delta → no extra publish.
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('reports refresh failures loudly (never silent)', async () => {
    const boom = new Error('worker exploded')
    const runPathsRefresh = vi.fn(async (_paths: string[]) => {
      throw boom
    })
    const onError = vi.fn()
    const refresh = createActiveRefresh({ runPathsRefresh, publish: vi.fn(), onError })

    refresh.markConversationDirty('/a/conv-1.jsonl')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(boom)
  })

  it('stop() cancels a pending flush', async () => {
    const runPathsRefresh = vi.fn(async (_paths: string[]) => emptyDelta)
    const refresh = createActiveRefresh({ runPathsRefresh, publish: vi.fn(), onError: vi.fn() })

    refresh.markConversationDirty('/a/conv-1.jsonl')
    refresh.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(runPathsRefresh).not.toHaveBeenCalled()
  })
})
