// @vitest-environment happy-dom

import type { SessionView } from '@podium/client-core/session-values'
import type { IssueNavigationModel } from '@podium/client-core/values'
import { attachMissionTestPreferences } from '@podium/client-graph/mission-screen.test.fixture'
import { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FoldedFlightDeckBar } from './FoldedFlightDeckBar'

const state = vi.hoisted(() => ({ pool: null as unknown }))

vi.mock('./store', () => ({
  useRuntimeSelector: (select: (store: Record<string, unknown>) => unknown) =>
    select({ sessions: [], selectedIssueId: 'root' }),
}))
vi.mock('./store-worklist-pool', () => ({
  useWorklistPool: () => state.pool as MobxPool,
  useWorklistPoolProjection: (read: (pool: MobxPool) => unknown) => {
    const pool = state.pool as MobxPool
    const projection = useMemo(() => createPoolProjection(pool, read), [pool, read])
    return useSyncExternalStore(projection.subscribe, projection.getSnapshot)
  },
}))

async function mount(
  onExpand = vi.fn(),
  options: { stages?: string[]; crew?: string[]; needs?: boolean; stage?: string } = {},
) {
  const stamp = '2026-10-01T12:00:00Z'
  const stages = options.stages ?? ['done', 'shipping', 'shipping', 'backlog', 'backlog']
  const needs = options.needs ?? true
  const issues = [
    {
      id: 'root',
      seq: 710,
      title: 'Mission',
      parentId: null,
      stage: options.stage ?? 'in_progress',
      needsHuman: needs,
    },
    ...stages.map((stage, index) => ({
      id: `child-${index}`,
      seq: 711 + index,
      title: `Child ${index}`,
      parentId: 'root',
      stage,
      needsHuman: needs && index === 3,
    })),
  ].map((issue) => ({
    ...issue,
    description: '',
    repoPath: '/fixture',
    deps: [],
    createdAt: stamp,
    updatedAt: stamp,
    readAt: stamp,
  })) as unknown as IssueNavigationModel[]
  const sessions = (options.crew ?? ['working', 'idle', 'idle']).map((phase, index) => ({
    sessionId: `seat-${index}`,
    issueId: 'root',
    cwd: '/fixture',
    title: `Agent ${index}`,
    agentKind: 'codex',
    status: 'live',
    archived: false,
    createdAt: stamp,
    lastActiveAt: stamp,
    agentState: { phase },
  })) as unknown as SessionView[]
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(stamp) }, undefined, {
    load: () => undefined,
    worklist: 'demand',
  })
  attachMissionTestPreferences(pool)
  pool.apply({
    type: 'replace',
    rows: [
      ...issues.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
      ...sessions.map((value) => ({ kind: 'session' as const, id: value.sessionId, value })),
    ],
  })
  state.pool = pool
  render(<FoldedFlightDeckBar onExpand={onExpand} />)
  await waitFor(() => expect(screen.getByTestId('flight-deck-gauge')).not.toBeNull())
}

afterEach(() => {
  cleanup()
  ;(state.pool as MobxPool | null)?.dispose()
  state.pool = null
})

describe('folded Flight Deck', () => {
  it('is a handle: the open control and the done/total count, nothing else', async () => {
    const onExpand = vi.fn()
    await mount(onExpand)

    const count = screen.getByTestId('flight-deck-gauge')
    expect(count.textContent).toBe('1/5')
    // The gauge's full sentence survives on the count's label and tooltip.
    expect(count.getAttribute('aria-label')).toContain('1 of 5 tasks done, 2 underway, 2 to go')
    expect(count.getAttribute('title')).toBe('1 of 5 tasks done, 2 underway, 2 to go')

    // No identity chip, tick gauge or foot stacks on the closed rail.
    expect(screen.queryByTestId('issue-id-square')).toBeNull()
    expect(screen.queryByTestId('deck-tick')).toBeNull()
    expect(screen.queryByTestId('flight-deck-attention')).toBeNull()
    expect(screen.queryByTestId('flight-deck-activity')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Open flight deck' }))
    fireEvent.click(count)
    expect(onExpand).toHaveBeenCalledTimes(2)
  })

  it('reports a zero-agent review root as review, not underway', async () => {
    await mount(vi.fn(), { stages: [], stage: 'review', crew: [] })

    const count = screen.getByTestId('flight-deck-gauge')
    expect(count.getAttribute('aria-label')).toContain('1 in review')
    expect(count.getAttribute('aria-label')).not.toContain('underway')
  })

  it('keeps the exact datum for a large mission', async () => {
    await mount(vi.fn(), {
      stages: [
        ...Array(30).fill('done'),
        ...Array(10).fill('shipping'),
        ...Array(20).fill('backlog'),
      ],
    })

    expect(screen.getByTestId('flight-deck-gauge').textContent).toBe('30/60')
  })
})
