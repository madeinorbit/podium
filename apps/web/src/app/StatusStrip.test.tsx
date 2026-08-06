// @vitest-environment happy-dom
import { asIssueId } from '@podium/model'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'

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
  return {
    issue: null as ReturnType<typeof makeIssue> | null,
    sessions: [] as Array<{ agentState?: { phase: string } }>,
    query,
    store: {
      paletteOpen: false,
      setPaletteOpen: vi.fn(),
      trpc: { sessions: { concurrencyHistory: { query } } },
    },
  }
})

vi.mock('./store', () => ({
  useReplicaIssues: () => (fixture.issue ? [fixture.issue] : []),
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

afterEach(() => {
  cleanup()
  fixture.issue = null
  fixture.sessions.length = 0
  fixture.query.mockClear()
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
      screen.getByLabelText('Review task POD-473: Footer issue status reference').dataset.issueStage,
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
    expect(screen.getByTestId('agent-concurrency-history')).toBeTruthy()
    expect(container.querySelectorAll('.status-strip-history-stack')).toHaveLength(24)
    await waitFor(() => expect(fixture.query).toHaveBeenCalled())
  })

  it('keeps the existing spinner and count while adding the capped pixel history', async () => {
    fixture.sessions.push(
      { agentState: { phase: 'working' } },
      { agentState: { phase: 'compacting' } },
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
})
