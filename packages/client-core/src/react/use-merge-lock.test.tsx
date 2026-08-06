// @vitest-environment happy-dom

import { asIssueId, asSessionId } from '@podium/model'
import type { LockWire } from '@podium/protocol'
import { act, cleanup, render } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type TestTrpc = {
  lock: { status: { query: ReturnType<typeof vi.fn> } }
}

let trpc: TestTrpc

vi.mock('./provider', () => ({
  useStoreSelector: (select: (state: { trpc: TestTrpc }) => unknown) => select({ trpc }),
}))

const { MERGE_LOCK_POLL_MS, useMergeLockState } = await import('./use-merge-lock')
type MergeLockState = ReturnType<typeof useMergeLockState>

const LOCK: LockWire = {
  repoId: 'repo_1',
  name: 'merge:main',
  holder: {
    sessionId: asSessionId('sess_holder'),
    issueId: asIssueId('iss_holder'),
    label: 'issue:#41',
  },
  note: 'landing',
  acquiredAt: '2026-08-06T12:00:00.000Z',
  expiresAt: '2026-08-06T12:02:00.000Z',
  secondsLeft: 120,
  queue: [
    {
      position: 1,
      sessionId: asSessionId('sess_first'),
      issueId: asIssueId('iss_first'),
      label: 'issue:#42',
      enqueuedAt: '2026-08-06T12:00:10.000Z',
    },
    {
      position: 2,
      sessionId: asSessionId('sess_second'),
      issueId: asIssueId('iss_second'),
      label: 'issue:#43',
      enqueuedAt: '2026-08-06T12:00:20.000Z',
    },
  ],
}

let latest: MergeLockState

function Probe({ repoPath }: { repoPath: string | null }): JSX.Element | null {
  latest = useMergeLockState(repoPath)
  return null
}

const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-06T12:00:30.000Z'))
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useMergeLockState', () => {
  it('delivers holder issue identity and the server-ordered FIFO queue, then polls at the bound', async () => {
    const query = vi.fn(async () => [LOCK])
    trpc = { lock: { status: { query } } }

    render(<Probe repoPath="/repo/worktree" />)
    await settle()

    expect(query).toHaveBeenCalledWith({ repoPath: '/repo/worktree', name: 'merge:main' })
    expect(latest.lock?.holder).toEqual(LOCK.holder)
    expect(latest.lock?.expiresAt).toBe(LOCK.expiresAt)
    expect(latest.lock?.secondsLeft).toBe(120)
    expect(latest.lock?.queue).toEqual(LOCK.queue)
    expect(latest.lock?.queue.map((waiter) => waiter.position)).toEqual([1, 2])
    expect(latest).toMatchObject({ loading: false, refreshing: false, error: null })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MERGE_LOCK_POLL_MS - 1)
    })
    expect(query).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('keeps the last good projection on a transient failure and refreshes to free', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([LOCK])
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([])
    trpc = { lock: { status: { query } } }

    render(<Probe repoPath="/repo" />)
    await settle()
    expect(latest.lock).toEqual(LOCK)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MERGE_LOCK_POLL_MS)
    })
    expect(latest.lock).toEqual(LOCK)
    expect(latest.error).toBe('offline')

    act(() => latest.refresh())
    await settle()
    expect(latest).toMatchObject({ lock: null, loading: false, refreshing: false, error: null })
  })

  it('does not query a hidden document and refreshes immediately when it becomes visible', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    const query = vi.fn(async () => [LOCK])
    trpc = { lock: { status: { query } } }

    render(<Probe repoPath="/repo" />)
    await settle()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MERGE_LOCK_POLL_MS * 2)
    })
    expect(query).not.toHaveBeenCalled()

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(query).toHaveBeenCalledTimes(1)
    expect(latest.lock).toEqual(LOCK)
  })

  it('never overlaps polls or a manual refresh with an in-flight read', async () => {
    let resolveFirst: (rows: LockWire[]) => void = () => {}
    const first = new Promise<LockWire[]>((resolve) => {
      resolveFirst = resolve
    })
    const query = vi.fn().mockReturnValueOnce(first).mockResolvedValue([LOCK])
    trpc = { lock: { status: { query } } }

    render(<Probe repoPath="/repo" />)
    await settle()
    expect(query).toHaveBeenCalledTimes(1)

    act(() => latest.refresh())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MERGE_LOCK_POLL_MS * 2)
    })
    expect(query).toHaveBeenCalledTimes(1)

    resolveFirst([LOCK])
    await settle()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MERGE_LOCK_POLL_MS)
    })
    expect(query).toHaveBeenCalledTimes(2)
  })
})
