// @vitest-environment happy-dom
import type { IssueNavigationModel } from '@podium/client-core/values'
import type { SessionView } from '@podium/client-core/session-values'
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
  useWorklistPoolProjection: (read: (pool: MobxPool) => unknown) => {
    const pool = state.pool as MobxPool
    const projection = useMemo(() => createPoolProjection(pool, read), [pool, read])
    return useSyncExternalStore(projection.subscribe, projection.getSnapshot)
  },
}))

async function mount(onExpand = vi.fn(), options: { stages?: string[]; crew?: string[]; needs?: boolean; stage?: string } = {}) {
  const stamp = '2026-10-01T12:00:00Z'
  const stages = options.stages ?? ['done', 'shipping', 'shipping', 'backlog', 'backlog']
  const needs = options.needs ?? true
  const issues = [
    { id: 'root', seq: 710, title: 'Mission', parentId: null, stage: options.stage ?? 'in_progress', needsHuman: needs },
    ...stages.map((stage, index) => ({ id: `child-${index}`, seq: 711 + index, title: `Child ${index}`,
      parentId: 'root', stage, needsHuman: needs && index === 3 })),
  ].map(issue => ({ ...issue, description: '', repoPath: '/fixture', deps: [], createdAt: stamp,
    updatedAt: stamp, readAt: stamp })) as unknown as IssueNavigationModel[]
  const sessions = (options.crew ?? ['working', 'idle', 'idle']).map((phase, index) => ({
    sessionId: `seat-${index}`, issueId: 'root', cwd: '/fixture', title: `Agent ${index}`, agentKind: 'codex',
    status: 'live', archived: false, createdAt: stamp, lastActiveAt: stamp, agentState: { phase },
  })) as unknown as SessionView[]
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(stamp) }, undefined,
    { load: () => undefined, worklist: 'demand' })
  pool.apply({ type: 'replace', rows: [
    ...issues.map(value => ({ kind: 'issue' as const, id: value.id, value })),
    ...sessions.map(value => ({ kind: 'session' as const, id: value.sessionId, value })),
  ] })
  state.pool = pool
  render(<FoldedFlightDeckBar onExpand={onExpand} />)
  await waitFor(() => expect(screen.getByTestId('issue-id-square').getAttribute('data-number')).toBe('710'))
}

afterEach(() => {
  cleanup()
  ;(state.pool as MobxPool | null)?.dispose()
  state.pool = null
})

const ticks = (): string[] =>
  screen.getAllByTestId('deck-tick').map((tick) => tick.getAttribute('data-s') ?? '')

describe('folded Flight Deck', () => {
  it('reports the mission on the closed rail: identity, gauge, foot', async () => {
    const onExpand = vi.fn()
    await mount(onExpand)

    // The mission's own ID square, not a column label.
    expect(screen.getByTestId('issue-id-square').getAttribute('data-number')).toBe('710')

    // One tick per task, in the open gauge's state order, and the exact datum.
    const gauge = screen.getByTestId('flight-deck-gauge')
    expect(gauge.getAttribute('data-resolution')).toBe('task')
    expect(ticks()).toEqual(['done', 'run', 'run', 'wait', 'wait'])
    expect(gauge.textContent).toContain('1/5')
    expect(gauge.getAttribute('aria-label')).toContain('1 of 5 tasks done, 2 underway, 2 to go')

    const activity = screen.getByTestId('flight-deck-activity')
    const attention = screen.getByTestId('flight-deck-attention')
    expect(activity.getAttribute('aria-label')).toContain('1 working')
    expect(attention.getAttribute('aria-label')).toContain('2 need you')
    expect(activity.textContent).toContain('1')
    expect(attention.textContent).toContain('2')

    fireEvent.click(activity)
    fireEvent.click(attention)
    fireEvent.click(gauge)
    expect(onExpand).toHaveBeenCalledTimes(3)
  })

  it('draws no attention stack when nothing is asking', async () => {
    await mount(vi.fn(), { needs: false, crew: ['idle'] })

    expect(screen.queryByTestId('flight-deck-attention')).toBeNull()
    expect(screen.getByTestId('flight-deck-activity')).not.toBeNull()
  })

  it('reports a zero-agent review root as review, not underway', async () => {
    await mount(vi.fn(), { stages: [], stage: 'review', crew: [] })

    const gauge = screen.getByTestId('flight-deck-gauge')
    expect(ticks()).toEqual(['review'])
    expect(gauge.getAttribute('aria-label')).toContain('1 in review')
    expect(gauge.getAttribute('aria-label')).not.toContain('underway')
    expect(screen.getByTestId('flight-deck-activity').getAttribute('aria-label')).toContain(
      '0 agents',
    )
    expect(screen.getByTestId('flight-deck-attention').textContent).toContain('1')
  })

  it('keeps the reading when a mission outgrows one tick per task', async () => {
    await mount(vi.fn(), { stages: [...Array(30).fill('done'), ...Array(10).fill('shipping'), ...Array(20).fill('backlog')] })

    const gauge = screen.getByTestId('flight-deck-gauge')
    expect(gauge.getAttribute('data-resolution')).toBe('share')
    // Four states at most, sized by share — never 60 ticks, never a clipped one.
    expect(ticks()).toEqual(['done', 'run', 'wait'])
    expect(gauge.textContent).toContain('30/60')
  })
})
