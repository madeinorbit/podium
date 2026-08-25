// @vitest-environment happy-dom
import { asIssueId } from '@podium/model'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'

const NOW = Date.parse('2026-08-06T18:20:00.000Z')

const fixture = vi.hoisted(() => {
  const query = vi.fn(async () => ({
    sampledAt: '2026-08-06T18:00:00.000Z',
    bucketMs: 30 * 60 * 1_000,
    peak: 16,
    buckets: Array.from({ length: 24 }, (_, index) => ({
      start: new Date(
        Date.parse('2026-08-06T06:00:00.000Z') + index * 30 * 60 * 1_000,
      ).toISOString(),
      count: index === 14 ? 16 : index % 6,
    })),
  }))
  const usageQuery = vi.fn(async () => ({
    hostname: 'test',
    sampledAt: '2026-08-06T18:20:00.000Z',
    buckets: [
      {
        hour: '2026-08-06T18:00:00.000Z',
        model: 'gpt-5',
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        messages: 1,
      },
      {
        // A large prior-hour burn must not dilute or inflate the live headline.
        hour: '2026-08-06T17:00:00.000Z',
        model: 'gpt-5',
        inputTokens: 12_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        messages: 1,
      },
    ],
  }))
  return {
    issue: null as ReturnType<typeof makeIssue> | null,
    extraIssues: [] as ReturnType<typeof makeIssue>[],
    sessions: [] as Array<{
      status?: string
      archived?: boolean
      agentState?: { phase: string }
    }>,
    query,
    usageQuery,
    store: {
      paletteOpen: false,
      setPaletteOpen: vi.fn(),
      trpc: {
        sessions: { concurrencyHistory: { query } },
        usage: { summary: { query: usageQuery } },
      },
    },
  }
})

vi.mock('./store', () => ({
  useReplicaIssues: () => [...(fixture.issue ? [fixture.issue] : []), ...fixture.extraIssues],
  useStoreSelector: (selector: (store: unknown) => unknown) =>
    selector({
      ...fixture.store,
      sessions: fixture.sessions,
      selectedIssueId: fixture.issue?.id,
    }),
}))

vi.mock('@/features/machines/ConnectionIndicator', () => ({
  ConnectionIndicator: () => null,
  useStableConnection: () => ({ health: 'healthy', visible: false }),
}))
// Feature-gated surfaces are OFF by default here. `omarchyPalette` flips only
// the command palette, which is the one gate the Omarchy tail below depends on.
let omarchyPalette = false
vi.mock('@/lib/use-feature', () => ({
  useFeature: (id: string) => (id === 'command-palette' ? omarchyPalette : false),
}))

import { resetUsageCache } from '@/features/usage/useUsageFeed'
import { recentBurnRate } from './StatusPerformanceStats'
import { StatusStrip } from './StatusStrip'
import { THEME_APPEARANCE_KEY, ThemeProvider } from './theme'

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
  cleanup()
  omarchyPalette = false
  localStorage.clear()
  resetUsageCache()
  fixture.issue = null
  fixture.extraIssues.length = 0
  fixture.sessions.length = 0
  fixture.query.mockClear()
  fixture.usageQuery.mockClear()
  vi.restoreAllMocks()
})

describe('StatusStrip issue reference', () => {
  it('shows the selected issue with a live stage glyph', () => {
    fixture.issue = makeIssue({
      id: asIssueId('iss_footer'),
      seq: 473,
      displayRef: 'POD-473',
      title: 'Footer issue status reference',
      stage: 'review',
    })

    const view = render(<StatusStrip />)
    expect(
      screen.getByLabelText('Review task POD-473: Footer issue status reference').dataset
        .issueStage,
    ).toBe('review')

    fixture.issue = { ...fixture.issue, stage: 'done' }
    view.rerender(<StatusStrip />)
    expect(
      screen.getByLabelText('Done task POD-473: Footer issue status reference').dataset.issueStage,
    ).toBe('done')
  })
})

describe('StatusStrip agent concurrency history', () => {
  it('keeps the zero state singular: no spinner and no numeric working phrase', async () => {
    const { container } = render(<StatusStrip />)

    expect(screen.getByTestId('status-strip-working').textContent).toBe('no agents working')
    expect(screen.queryByText('0 agents working')).toBeNull()
    expect(container.querySelector('.status-strip-spinner')).toBeNull()
    const graph = screen.getByTestId('agent-concurrency-history')
    expect(graph).toBeTruthy()
    expect(graph.querySelectorAll('.status-strip-history-stack')).toHaveLength(24)
    await waitFor(() => expect(fixture.query).toHaveBeenCalled())
  })

  it('shares the live concurrency reading through a prefilled X intent', () => {
    fixture.sessions.push({ status: 'live', agentState: { phase: 'working' } })

    render(<StatusStrip />)

    const share = screen.getByLabelText('Share agent concurrency on X') as HTMLAnchorElement
    expect(share.target).toBe('_blank')
    expect(share.rel).toContain('noreferrer')
    expect(decodeURIComponent(share.href)).toContain(
      '1 agent is mid-session in @podium_ade right now',
    )
  })

  it('keeps the spinner and scales concurrency to the visible-window peak', async () => {
    fixture.sessions.push(
      { status: 'live', agentState: { phase: 'working' } },
      { status: 'live', agentState: { phase: 'compacting' } },
    )
    const { container } = render(<StatusStrip />)

    expect(screen.getByTestId('status-strip-working').textContent).toContain('2 agents working')
    expect(container.querySelector('.status-strip-spinner')).toBeTruthy()
    await waitFor(() => {
      const stacks = container.querySelectorAll<HTMLElement>('.status-strip-history-stack')
      expect(stacks[14]?.style.getPropertyValue('--history-height')).toBe('12px')
      expect(stacks[11]?.style.getPropertyValue('--history-height')).toBe('4px')
    })
    expect(screen.getByTestId('agent-concurrency-history').getAttribute('aria-label')).toContain(
      '2 agents working now. Peak 16.',
    )
  })

  /** POD-730: the phase outlives the process on purpose (exit keeps the final
   *  turn diagnosis, hibernation keeps "needs input" amber), so a raw phase
   *  count only ever ratchets up. */
  it('does not count agents whose process is gone or parked', () => {
    fixture.sessions.push(
      { status: 'live', agentState: { phase: 'working' } },
      { status: 'exited', agentState: { phase: 'working' } },
      { status: 'hibernated', agentState: { phase: 'working' } },
      { status: 'live', archived: true, agentState: { phase: 'compacting' } },
    )

    render(<StatusStrip />)

    expect(screen.getByTestId('status-strip-working').textContent).toContain('1 agent working')
  })

  it('still counts a reconnecting agent: the link dropped, not the agent', () => {
    fixture.sessions.push({ status: 'reconnecting', agentState: { phase: 'working' } })

    render(<StatusStrip />)

    expect(screen.getByTestId('status-strip-working').textContent).toContain('1 agent working')
  })
})

describe('StatusStrip token burn', () => {
  it('bootstraps from the current hour until a second fresh scan arrives', async () => {
    render(<StatusStrip />)

    expect(screen.getByTestId('status-strip-burn').textContent).toBe('—/h burn')
    await waitFor(() =>
      expect(screen.getByTestId('status-strip-burn').textContent).toBe('$3.75/h burn'),
    )
    expect(
      screen.getByTestId('token-burn-history').querySelectorAll('.status-strip-history-stack'),
    ).toHaveLength(12)
    const burnShare = decodeURIComponent(
      screen.getByLabelText('Share token burn on X').getAttribute('href') ?? '',
    )
    expect(burnShare).toContain('x.com/intent/post')
    // $3.75/hr is under the flex threshold, so it takes the small-burn closer.
    expect(burnShare).toContain('I am running @podium_ade on $3.75/hr in tokens')
    expect(screen.queryByTestId('ship-rate-history')).toBeNull()
    expect(screen.queryByTestId('status-strip-ship')).toBeNull()
  })

  it('uses the cost delta between fresh scans, including across an hour boundary', () => {
    const bucket = (hour: string, inputTokens: number) => ({
      hour,
      model: 'gpt-5',
      inputTokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      messages: 1,
    })
    const previous = {
      sampledAt: Date.parse('2026-08-06T17:59:00.000Z'),
      buckets: [bucket('2026-08-06T17:00:00.000Z', 1_000_000)],
    }
    const current = {
      sampledAt: Date.parse('2026-08-06T18:02:00.000Z'),
      buckets: [
        bucket('2026-08-06T17:00:00.000Z', 1_000_000),
        bucket('2026-08-06T18:00:00.000Z', 1_000_000),
      ],
    }

    expect(recentBurnRate(previous, current)).toBeCloseTo(25)
  })

  it('drops the 12h caption; the window is stated in the tooltip foot', () => {
    const { container } = render(<StatusStrip />)

    expect(container.querySelector('.status-strip-history-label')).toBeNull()
    expect(screen.queryAllByText('12h')).toHaveLength(0)
  })
})

/**
 * THE OMARCHY TAIL (POD-1531).
 *
 * The strip's admission rule is the thing under test, not the words: both of
 * these readings exist ONLY under the profile whose design asks for them, so the
 * assertions that matter are the NEGATIVE ones — the Podium appearance's strip
 * must be byte-for-byte what it was before the profile existed.
 */
describe('StatusStrip Omarchy tail', () => {
  const renderWithAppearance = (appearance: 'podium' | 'omarchy') => {
    localStorage.setItem(THEME_APPEARANCE_KEY, appearance)
    return render(
      <ThemeProvider>
        <StatusStrip />
      </ThemeProvider>,
    )
  }

  it('names the appearance under the Omarchy profile', () => {
    renderWithAppearance('omarchy')
    expect(screen.getByTestId('status-strip-profile').textContent).toBe('omarchy · tokyo-night')
  })

  it('says nothing about the appearance under Podium, where there is only one', () => {
    renderWithAppearance('podium')
    expect(screen.queryByTestId('status-strip-profile')).toBeNull()
  })

  it('brings the palette hint back only on Omarchy, and only with a palette', () => {
    omarchyPalette = true
    renderWithAppearance('omarchy')
    expect(screen.getByText(/commands$/)).toBeTruthy()
    cleanup()

    // Same profile, no palette: a hint for a key that does nothing.
    omarchyPalette = false
    renderWithAppearance('omarchy')
    expect(screen.queryByText(/commands$/)).toBeNull()
    cleanup()

    // Podium keeps the strip clear whatever the palette is doing — the hint was
    // cut on the merits there and this profile does not reopen that.
    omarchyPalette = true
    renderWithAppearance('podium')
    expect(screen.queryByText(/commands$/)).toBeNull()
  })
})
