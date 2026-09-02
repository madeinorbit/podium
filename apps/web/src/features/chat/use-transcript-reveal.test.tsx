// @vitest-environment happy-dom
import { asSessionId, type TranscriptItem } from '@podium/model'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatBlock, ChatRow } from './chat'
import { transcriptRevealRow, useTranscriptReveal } from './use-transcript-reveal'

const toast = vi.hoisted(() => ({ info: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const transcriptItem = (id: string, cursor = id): TranscriptItem => ({
  id,
  cursor,
  role: 'assistant',
  text: id,
})
const block = (id: string): ChatBlock => ({ item: transcriptItem(id) })
const single = (blockIndex: number, value: ChatBlock): ChatRow => ({
  kind: 'block',
  blockIndex,
  block: value,
})

const sid = asSessionId('reveal-session')

beforeEach(() => {
  toast.info.mockReset()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  window.matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia
})

afterEach(() => vi.unstubAllGlobals())

describe('transcript reveal', () => {
  it('maps an item inside a tool batch to the batch row', () => {
    const blocks = [block('lead'), block('tool-a'), block('tool-b')]
    const rows: ChatRow[] = [
      single(0, blocks[0]!),
      { kind: 'tools', blockIndices: [1, 2], blocks: blocks.slice(1), title: 'Tools' },
    ]
    expect(transcriptRevealRow(blocks, rows, 'tool-b')).toBe(1)
  })

  it('centers a loaded row, highlights it, and clears its nonce', () => {
    const blocks = [block('target')]
    const rows = [single(0, blocks[0]!)]
    const scrollToBlock = vi.fn()
    const clear = vi.fn()
    const { result } = renderHook(() =>
      useTranscriptReveal({
        active: true,
        sessionId: sid,
        request: { nonce: 4, sessionId: sid, itemKey: 'target' },
        blocks,
        rows,
        initialLoaded: true,
        computeReady: true,
        loadingOlder: false,
        moreAbove: false,
        renderStart: 0,
        setRenderCount: vi.fn(),
        loadOlder: vi.fn(),
        scrollToBlock,
        clear,
      }),
    )
    expect(result.current).toBe(0)
    expect(scrollToBlock).toHaveBeenCalledWith(0, { instant: false })
    expect(clear).toHaveBeenCalledWith(4)
  })

  it('keeps the consumed row highlighted after the request is cleared', () => {
    const blocks = [block('target')]
    const rows = [single(0, blocks[0]!)]
    const stable = {
      active: true,
      sessionId: sid,
      blocks,
      rows,
      initialLoaded: true,
      computeReady: true,
      loadingOlder: false,
      moreAbove: false,
      renderStart: 0,
      setRenderCount: vi.fn(),
      loadOlder: vi.fn(),
      scrollToBlock: vi.fn(),
      clear: vi.fn(),
    }
    // `initialProps` is what renderHook infers Props from, and a non-null literal
    // there would narrow it past the `| null` this test exists to exercise.
    const initialProps: {
      request: { nonce: number; sessionId: typeof sid; itemKey: string } | null
    } = { request: { nonce: 10, sessionId: sid, itemKey: 'target' } }
    const { result, rerender } = renderHook(
      ({ request }: typeof initialProps) => useTranscriptReveal({ ...stable, request }),
      { initialProps },
    )

    expect(result.current).toBe(0)
    rerender({ request: null })
    expect(result.current).toBe(0)
  })

  it('expands a windowed target before scrolling', () => {
    const blocks = [block('target'), block('tail')]
    const rows = [single(0, blocks[0]!), single(1, blocks[1]!)]
    const setRenderCount = vi.fn()
    const scrollToBlock = vi.fn()
    const clear = vi.fn()
    const stable = {
      active: true,
      sessionId: sid,
      request: { nonce: 5, sessionId: sid, itemKey: 'target' },
      blocks,
      rows,
      initialLoaded: true,
      computeReady: true,
      loadingOlder: false,
      moreAbove: true,
      setRenderCount,
      loadOlder: vi.fn(),
      scrollToBlock,
      clear,
    }
    const { rerender } = renderHook(
      ({ renderStart }: { renderStart: number }) => useTranscriptReveal({ ...stable, renderStart }),
      { initialProps: { renderStart: 1 } },
    )
    expect(setRenderCount).toHaveBeenCalled()
    expect(scrollToBlock).not.toHaveBeenCalled()

    rerender({ renderStart: 0 })
    expect(scrollToBlock).toHaveBeenCalledWith(0, { instant: false })
    expect(clear).toHaveBeenCalledWith(5)
  })

  it('loads older history until the target appears and reports a missing position', () => {
    const loadOlder = vi.fn()
    const clear = vi.fn()
    const scrollToBlock = vi.fn()
    const base = {
      active: true,
      sessionId: sid,
      request: { nonce: 6, sessionId: sid, itemKey: 'older' },
      rows: [] as ChatRow[],
      initialLoaded: true,
      computeReady: true,
      loadingOlder: false,
      renderStart: 0,
      setRenderCount: vi.fn(),
      loadOlder,
      scrollToBlock,
      clear,
    }
    const { rerender } = renderHook(
      ({ blocks, moreAbove }: { blocks: ChatBlock[]; moreAbove: boolean }) =>
        useTranscriptReveal({
          ...base,
          blocks,
          rows: blocks.map((value, index) => single(index, value)),
          moreAbove,
        }),
      { initialProps: { blocks: [] as ChatBlock[], moreAbove: true } },
    )
    expect(loadOlder).toHaveBeenCalledTimes(1)

    rerender({ blocks: [block('older')], moreAbove: false })
    expect(scrollToBlock).toHaveBeenCalledWith(0, { instant: false })
    expect(clear).toHaveBeenCalledWith(6)

    const missingClear = vi.fn()
    rerender({ blocks: [], moreAbove: false })
    renderHook(() =>
      useTranscriptReveal({
        ...base,
        request: { nonce: 7, sessionId: sid, itemKey: 'gone' },
        blocks: [],
        moreAbove: false,
        clear: missingClear,
      }),
    )
    expect(missingClear).toHaveBeenCalledWith(7)
    expect(toast.info).toHaveBeenCalledWith('That transcript position is no longer available.')
  })

  it('terminates the request when an older-page attempt does not advance the window', () => {
    const loadOlder = vi.fn()
    const clear = vi.fn()
    const request = { nonce: 9, sessionId: sid, itemKey: 'unreachable' }
    const stable = {
      active: true,
      sessionId: sid,
      request,
      rows: [] as ChatRow[],
      initialLoaded: true,
      computeReady: true,
      loadingOlder: false,
      moreAbove: true,
      renderStart: 0,
      setRenderCount: vi.fn(),
      loadOlder,
      scrollToBlock: vi.fn(),
      clear,
    }
    const { rerender } = renderHook(
      ({ blocks }: { blocks: ChatBlock[] }) => useTranscriptReveal({ ...stable, blocks }),
      { initialProps: { blocks: [] as ChatBlock[] } },
    )
    expect(loadOlder).toHaveBeenCalledTimes(1)

    rerender({ blocks: [] })
    expect(loadOlder).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledWith(9)
    expect(toast.info).toHaveBeenCalledWith('That transcript position is no longer available.')
  })

  it('uses an instant centered scroll when reduced motion is requested', () => {
    window.matchMedia = vi.fn(() => ({ matches: true })) as unknown as typeof window.matchMedia
    const blocks = [block('target')]
    const scrollToBlock = vi.fn()
    renderHook(() =>
      useTranscriptReveal({
        active: true,
        sessionId: sid,
        request: { nonce: 8, sessionId: sid, itemKey: 'target' },
        blocks,
        rows: [single(0, blocks[0]!)],
        initialLoaded: true,
        computeReady: true,
        loadingOlder: false,
        moreAbove: false,
        renderStart: 0,
        setRenderCount: vi.fn(),
        loadOlder: vi.fn(),
        scrollToBlock,
        clear: vi.fn(),
      }),
    )
    expect(scrollToBlock).toHaveBeenCalledWith(0, { instant: true })
  })
})
