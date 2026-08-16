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
    buckets: [
      {
        hour: '2026-08-06T17:00:00.000Z',
        model: 'gpt-5',
        inputTokens: 1_000_000,
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
vi.mock('@/lib/use-feature', () => ({ useFeature: () => false }))

import { resetUsageCache } from '@/features/usage/useUsageFeed'
import { StatusStrip } from './StatusStrip'

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
  cleanup()
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

  it('keeps the existing spinner and count while adding the capped pixel history', async () => {
    fixture.sessions.push(
      { status: 'live', agentState: { phase: 'working' } },
      { status: 'live', agentState: { phase: 'compacting' } },
    )
    const { container } = render(<StatusStrip />)

    expect(screen.getByTestId('status-strip-working').textContent).toContain('2 agents working')
    expect(container.querySelector('.status-strip-spinner')).toBeTruthy()
    await waitFor(() =>
      expect(container.querySelectorAll('[data-over-cap="true"]')).toHaveLength(1),
    )
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

describe('StatusStrip burn and ship rates', () => {
  it('reuses API-equivalent pricing for a rolling hourly burn rate', async () => {
    render(<StatusStrip />)

    expect(screen.getByTestId('status-strip-burn').textContent).toBe('—/h burn')
    await waitFor(() =>
      expect(screen.getByTestId('status-strip-burn').textContent).toBe('$0.10/h burn'),
    )
    expect(
      screen.getByTestId('token-burn-history').querySelectorAll('.status-strip-history-stack'),
    ).toHaveLength(12)
    const burnShare = decodeURIComponent(
      screen.getByLabelText('Share token burn on X').getAttribute('href') ?? '',
    )
    expect(burnShare).toContain('x.com/intent/post')
    expect(burnShare).toContain('@podium_ade is burning $0.10/hr in tokens')
  })

  /** The verdict this used to require (`gitState.merged`) is probed live and
   *  lost on every server restart, so it read "1 ship" on an 18-ship day. The
   *  ship is now the close itself: done, on a branch, inside the trailing day. */
  it('counts issues closed as done on a branch, over a trailing day', () => {
    fixture.extraIssues.push(
      makeIssue({ id: 'landed', closedReason: 'done', closedAt: '2026-08-06T17:15:00.000Z' }),
      // Yesterday evening — still inside 24h, outside the old 12h window.
      makeIssue({
        id: 'landed-yesterday',
        closedReason: 'done',
        closedAt: '2026-08-05T20:00:00.000Z',
      }),
      // Just past the 24h edge.
      makeIssue({ id: 'stale', closedReason: 'done', closedAt: '2026-08-05T17:00:00.000Z' }),
      makeIssue({
        id: 'cancelled',
        closedReason: 'cancelled',
        closedAt: '2026-08-06T17:30:00.000Z',
      }),
      makeIssue({
        id: 'no-branch',
        closedReason: 'done',
        branch: null,
        closedAt: '2026-08-06T17:45:00.000Z',
      }),
      makeIssue({
        id: 'deleted',
        closedReason: 'done',
        closedAt: '2026-08-06T17:50:00.000Z',
        deletedAt: '2026-08-06T18:00:00.000Z',
      }),
    )

    render(<StatusStrip />)

    expect(screen.getByTestId('status-strip-ship').textContent).toBe('2 ships/day')
    expect(
      screen.getByTestId('ship-rate-history').querySelectorAll('.status-strip-history-stack'),
    ).toHaveLength(24)
    expect(screen.getByTestId('ship-rate-history').getAttribute('aria-label')).toContain(
      '2 issues shipped over the last 24 hours',
    )
    expect(
      decodeURIComponent(screen.getByLabelText('Share ship rate on X').getAttribute('href') ?? ''),
    ).toContain('2 issues shipped on @podium_ade in the last 24h')
  })

  it('keeps the singular reading when exactly one issue shipped', () => {
    fixture.extraIssues.push(
      makeIssue({ id: 'landed', closedReason: 'done', closedAt: '2026-08-06T17:15:00.000Z' }),
    )

    render(<StatusStrip />)

    expect(screen.getByTestId('status-strip-ship').textContent).toBe('1 ship/day')
  })

  it('draws an empty bucket as a dimmed 1px floor, never as nothing', () => {
    render(<StatusStrip />)

    const stacks = screen
      .getByTestId('ship-rate-history')
      .querySelectorAll<HTMLElement>('.status-strip-history-stack')
    expect(stacks).toHaveLength(24)
    for (const stack of stacks) {
      expect(stack.dataset.zero).toBe('true')
      expect(stack.style.getPropertyValue('--history-height')).toBe('1px')
    }
  })

  it('drops the 12h caption; the window is stated in the tooltip foot', () => {
    const { container } = render(<StatusStrip />)

    expect(container.querySelector('.status-strip-history-label')).toBeNull()
    expect(screen.queryAllByText('12h')).toHaveLength(0)
  })
})
