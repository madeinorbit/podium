import type { UsageBucketWire } from '@podium/model'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageView } from './UsageView'
import { PENDING_REVEAL_MS, resetUsageCache } from './useUsageFeed'

/**
 * The sheet's loading behaviour (POD-394). What is asserted here is the promise
 * the design makes: the instrument is on screen before its readings are, the
 * readings survive a close/reopen, and a read that fails says so instead of
 * loading forever.
 */

const summary = vi.hoisted(() => vi.fn())
// ONE store object for the whole file. Handing the selector a fresh literal each
// render would change `trpc`'s identity every pass and re-run the feed's effect
// forever — the real store returns the same client every time.
const store = vi.hoisted(() => ({ trpc: { usage: { summary: { query: summary } } } }))

vi.mock('@/app/store', () => ({
  useStoreSelector: (select: (s: typeof store) => unknown) => select(store),
}))

const bucket = (over: Partial<UsageBucketWire> = {}): UsageBucketWire => ({
  hour: new Date().toISOString(),
  model: 'claude-opus-5',
  inputTokens: 1_000,
  outputTokens: 2_000,
  cacheReadTokens: 3_000,
  cacheCreationTokens: 4_000,
  messages: 5,
  ...over,
})

/** Never resolves — holds the sheet in whichever state it opened in. */
const pending = (): Promise<never> => new Promise<never>(() => {})

const body = (): HTMLElement => screen.getByTestId('usage-sheet').querySelector('.usage-body')!

beforeEach(() => {
  resetUsageCache()
  summary.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('UsageView loading', () => {
  it('draws the whole instrument while cold, with the readings unfilled', async () => {
    summary.mockReturnValue(pending())
    render(<UsageView onClose={() => {}} />)

    // Everything knowable before the fetch is REAL — this is what keeps the
    // fit-height sheet from snapping to a new size when the answer lands.
    expect(screen.getByText('Last 5 hours')).toBeTruthy()
    expect(screen.getByText('Tokens per day')).toBeTruthy()
    expect(screen.getByText('API-equivalent')).toBeTruthy()
    expect(body().querySelectorAll('.usage-bar')).toHaveLength(7)
    expect(body().querySelectorAll('.usage-gridline')).toHaveLength(3)

    // ...and every figure is an unfilled slot, not a zero. A `0` here would be a
    // claim about a number nobody has read yet.
    expect(body().querySelectorAll('.usage-unfilled').length).toBeGreaterThan(0)
    expect(body().dataset.cold).toBe('true')
    expect(body().getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByText('Loading usage…')?.className).toContain('sr-only')
  })

  it('fills the readings in place and drops the cold marker', async () => {
    summary.mockResolvedValue({ buckets: [bucket()] })
    render(<UsageView onClose={() => {}} />)
    await act(async () => {})

    expect(body().dataset.cold).toBeUndefined()
    expect(body().querySelectorAll('.usage-unfilled')).toHaveLength(0)
    expect(body().querySelectorAll('.usage-bar')).toHaveLength(7)
    // The arrival animation is licensed exactly once, for the pass that filled
    // a cold sheet.
    expect(body().dataset.arrive).toBe('true')
    expect(screen.getByText('claude-opus-5')).toBeTruthy()
  })

  it('reopens straight into the last readings, with no cold pass and no entrance', async () => {
    summary.mockResolvedValue({ buckets: [bucket()] })
    const first = render(<UsageView onClose={() => {}} />)
    await act(async () => {})
    first.unmount()

    // Second open: the request is in flight and will never answer, so anything
    // on screen came from the cache.
    summary.mockReturnValue(pending())
    render(<UsageView onClose={() => {}} />)
    expect(body().dataset.cold).toBeUndefined()
    expect(body().querySelectorAll('.usage-unfilled')).toHaveLength(0)
    expect(screen.getByText('claude-opus-5')).toBeTruthy()
    // Already readable, so it gets no entrance — that would be choreography over
    // content the operator can read right now.
    expect(body().dataset.arrive).toBeUndefined()
  })

  it('admits a slow refresh only once it has outrun the reveal delay', async () => {
    vi.useFakeTimers()
    summary.mockReturnValue(pending())
    render(<UsageView onClose={() => {}} />)

    // Below the threshold the sheet stays completely still — a hairline that
    // appears and vanishes inside 60ms reads as a fault, not as work.
    await act(async () => {
      vi.advanceTimersByTime(PENDING_REVEAL_MS - 50)
    })
    expect(body().querySelector('.usage-refreshing')).toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    expect(body().querySelector('.usage-refreshing')).not.toBeNull()
  })

  it('offers a retry when the first read fails, instead of loading forever', async () => {
    summary.mockRejectedValue(new Error('offline'))
    render(<UsageView onClose={() => {}} />)
    await act(async () => {})

    expect(screen.getByText("Couldn't read usage from the daemon.")).toBeTruthy()

    summary.mockResolvedValue({ buckets: [bucket()] })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await act(async () => {})
    expect(screen.getByText('claude-opus-5')).toBeTruthy()
  })

  it('keeps the last readings when a refresh fails, and stamps them stale', async () => {
    vi.useFakeTimers()
    summary.mockResolvedValue({ buckets: [bucket()] })
    render(<UsageView onClose={() => {}} />)
    await act(async () => {})
    expect(screen.queryByText(/LAST READ/)).toBeNull()

    summary.mockRejectedValue(new Error('offline'))
    await act(async () => {
      vi.advanceTimersByTime(90_000)
    })

    expect(screen.getByText('claude-opus-5')).toBeTruthy()
    expect(screen.getByText(/^LAST READ \d\d:\d\d$/)).toBeTruthy()
  })
})
