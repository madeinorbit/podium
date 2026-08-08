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

const ZERO_TOKENS = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
} as const

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
    expect(screen.getByText('Last 7 days · API-equivalent')).toBeTruthy()
    expect(screen.getByText('Cost per hour')).toBeTruthy()
    expect(screen.getByText('Where it went')).toBeTruthy()
    expect(screen.getByText('API-equivalent')).toBeTruthy()
    // Seven days of 24 hour slots — the trace's geometry is known before any
    // reading is, which is the whole reason the sheet does not resize on arrival.
    expect(body().querySelectorAll('.usage-trace-day')).toHaveLength(7)
    expect(body().querySelectorAll('.usage-hour')).toHaveLength(7 * 24)
    expect(body().querySelectorAll('.usage-gridline')).toHaveLength(3)
    // No hour claims a reading yet: `data-on` is what marks a measured hour, and
    // a cold trace must not draw a single bar.
    expect(body().querySelectorAll('.usage-hour[data-on]')).toHaveLength(0)

    // Every interpretation added to the finished sheet owns its own unfilled
    // slot in the cold pass, so none of these regions appears or changes height
    // only after the request resolves.
    expect(
      screen.getByTestId('usage-sheet').querySelector('.usage-window-span .usage-unfilled'),
    ).toBeTruthy()
    expect(body().querySelector('.usage-window-sub .usage-unfilled')).toBeTruthy()
    expect(body().querySelector('.usage-cache-saving .usage-unfilled')).toBeTruthy()
    expect(body().querySelectorAll('.usage-provider-row')).toHaveLength(2)
    expect(body().querySelectorAll('.usage-provider-row .usage-unfilled').length).toBeGreaterThan(0)
    expect(body().querySelectorAll('.usage-comp-ratio .usage-unfilled')).toHaveLength(4)
    expect(body().querySelector('.usage-prov[data-wide] .usage-unfilled')).toBeTruthy()

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
    expect(body().querySelectorAll('.usage-hour')).toHaveLength(7 * 24)
    // The single bucket is one measured hour; the other 167 slots stay empty,
    // because a gap in the trace is a reading and not a missing value.
    expect(body().querySelectorAll('.usage-hour[data-on]')).toHaveLength(1)
    // The arrival animation is licensed exactly once, for the pass that filled
    // a cold sheet.
    expect(body().dataset.arrive).toBe('true')
    expect(screen.getByText('claude-opus-5')).toBeTruthy()
  })

  it('gives every measured hour a readout, since 168 columns cannot be labelled', async () => {
    // The trace's precise values live on hover — the only place they can, at one
    // column per hour. An unlabelled 4px mark with no readout would be a shape
    // and not a chart.
    summary.mockResolvedValue({ buckets: [bucket()] })
    render(<UsageView onClose={() => {}} />)
    await act(async () => {})

    const measured = body().querySelector('.usage-hour[data-on]')!
    expect(measured.getAttribute('title')).toMatch(/\d\d:00 · .* tokens · \$/)
  })

  it('defaults the trace to cost and switches every chart reading to tokens', async () => {
    summary.mockResolvedValue({ buckets: [bucket()] })
    render(<UsageView onClose={() => {}} />)
    await act(async () => {})

    const figure = body().querySelector('.usage-figure')
    expect(figure).toBeTruthy()
    expect(screen.getByText('Cost per hour')).toBeTruthy()
    expect(figure?.textContent).toMatch(/peak \$/)

    const tokens = screen.getByRole('button', { name: 'Tokens' })
    fireEvent.click(tokens)
    expect(tokens.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('Tokens per hour')).toBeTruthy()
    expect(figure?.textContent).toMatch(/peak 10k/)
  })

  it('omits the cache interpretation when cache reads cost nothing', async () => {
    summary.mockResolvedValue({ buckets: [bucket({ cacheReadTokens: 0 })] })
    render(<UsageView onClose={() => {}} />)
    await act(async () => {})

    expect(screen.queryByText(/Cache reads bill at 10% of input/)).toBeNull()
  })

  it('names models that used fallback pricing in the footer', async () => {
    summary.mockResolvedValue({ buckets: [bucket({ model: 'future-vendor-model' })] })
    render(<UsageView onClose={() => {}} />)
    await act(async () => {})

    expect(screen.getByText(/1 model used the fallback rate: future-vendor-model/)).toBeTruthy()
  })

  it('drops the harness placeholder rather than ranking it as a model', async () => {
    // Claude Code stamps its session-limit and API-error placeholders
    // `<synthetic>` with an all-zero usage block. Counted, they put a permanent
    // 0-token row in the table and add to every reply count.
    summary.mockResolvedValue({
      buckets: [bucket(), bucket({ model: '<synthetic>', ...ZERO_TOKENS, messages: 9 })],
    })
    render(<UsageView onClose={() => {}} />)
    await act(async () => {})

    expect(screen.queryByText('<synthetic>')).toBeNull()
    expect(body().querySelectorAll('.usage-table tbody tr')).toHaveLength(1)
    // ...and its replies are gone from the window readout too: 5, not 14.
    expect(screen.getAllByText(/5 replies/).length).toBeGreaterThan(0)
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
    expect(screen.getByText(/^[A-Z]{3} \d\d – [A-Z]{3} \d\d · ROLLING$/)).toBeTruthy()
  })
})
