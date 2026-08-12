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

import { StatusStrip } from './StatusStrip'
import { resetUsageCache } from '@/features/usage/useUsageFeed'

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

  it('counts only confirmed landed issues, including PR-backed merges', () => {
    fixture.extraIssues.push(
      makeIssue({
        id: 'merged-pr',
        closedAt: '2026-08-06T17:15:00.000Z',
        prUrl: 'https://github.com/podium/podium/pull/42',
        gitState: {
          updatedAt: '2026-08-06T18:00:00.000Z',
          branch: 'issue/42',
          shared: false,
          ahead: 0,
          dirtyFiles: 0,
          merged: true,
        },
      }),
      makeIssue({
        id: 'open-pr',
        closedAt: '2026-08-06T17:30:00.000Z',
        prUrl: 'https://github.com/podium/podium/pull/43',
        gitState: {
          updatedAt: '2026-08-06T18:00:00.000Z',
          branch: 'issue/43',
          shared: false,
          ahead: 1,
          dirtyFiles: 0,
          merged: false,
        },
      }),
    )

    render(<StatusStrip />)

    expect(screen.getByTestId('status-strip-ship').textContent).toBe('0.08 ships/h')
    expect(screen.getByTestId('ship-rate-history').getAttribute('aria-label')).toContain(
      '1 confirmed merge over the last 12 hours',
    )
    expect(
      decodeURIComponent(screen.getByLabelText('Share ship rate on X').getAttribute('href') ?? ''),
    ).toContain('1 merge landed in the last 12h on @podium_ade')
  })
})
