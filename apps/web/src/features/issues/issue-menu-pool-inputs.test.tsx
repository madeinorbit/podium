import type { SessionView } from '@podium/client-core/session-values'
import { MobxPool } from '@podium/client-graph'
import { MISSION_VIEW_SUMMARIES } from '@podium/client-graph/mission-view-schema'
import { asIssueId, asMachineId, asSessionId } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { type ComponentProps, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import type { IssueContextMenu } from './IssueContextMenu'
import { PoolIssueContextMenu } from './issue-menu-pool-inputs'

type MenuProps = ComponentProps<typeof IssueContextMenu>
const f = vi.hoisted(() => ({
  pool: null as MobxPool | null,
  derivations: 0,
  menu: null as MenuProps | null,
}))
vi.mock('./IssueContextMenu', () => ({
  IssueContextMenu: (props: MenuProps) => {
    f.menu = props
    return (
      <output data-testid="pool-task-menu">
        {props.poolInputs.sessions.map((session) => session.title).join(',')}
      </output>
    )
  },
}))
vi.mock('@podium/client-core/react', () => ({
  useStoreHandle: () => ({
    getSnapshot: () => {
      throw new Error('Task reader borrowed the old store')
    },
  }),
}))
vi.mock('@/app/store-worklist-pool', async () => {
  const { useMemo, useSyncExternalStore } = await import('react')
  const { createPoolProjection } = await import('@podium/client-graph/runtime-pool')
  const subscribe = () => () => {}
  return {
    useWorklistPoolProjection<T>(read: (pool: MobxPool) => T, empty: T): T {
      const pool = f.pool
      const projection = useMemo(
        () =>
          pool
            ? createPoolProjection(pool, (current) => {
                f.derivations++
                return read(current)
              })
            : null,
        [pool, read],
      )
      return useSyncExternalStore(
        projection?.subscribe ?? subscribe,
        () => projection?.getSnapshot() ?? empty,
      )
    },
  }
})

const pools: MobxPool[] = []
afterEach(() => {
  cleanup()
  for (const pool of pools.splice(0)) pool.dispose()
  f.pool = null
  f.menu = null
  f.derivations = 0
  vi.restoreAllMocks()
})
const stamp = '2026-10-01T12:00:00Z'
const chosenIssue = makeIssue({
  id: 'chosen-issue',
  audience: 'agent',
  stage: 'done',
  closedAt: '2026-09-20T12:00:00Z',
  updatedAt: '2026-09-20T12:00:00Z',
  memberSessionIds: ['chosen-session'],
})
const props = {
  issues: [chosenIssue],
  allIssues: [chosenIssue],
  anchor: { x: 10, y: 10 },
  onClose: () => {},
  onOpen: () => {},
}
function open(scale: number) {
  const row = (id: string, issueId: string): SessionView => ({
    sessionId: asSessionId(id),
    issueId: asIssueId(issueId),
    title: 'Pool task member',
    cwd: '/synthetic/menu',
    agentKind: 'codex',
    status: 'exited',
    archived: true,
    unread: false,
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    origin: { kind: 'spawn' },
    readAt: null,
    createdAt: stamp,
    lastActiveAt: stamp,
  })
  const sessions = [
    row('chosen-session', 'chosen-issue'),
    ...Array.from({ length: 64 * scale - 1 }, (_, i) => row(`unrelated-${i}`, 'background-issue')),
  ]
  const background = makeIssue({
    ...chosenIssue,
    id: 'background-issue',
    memberSessionIds: sessions.slice(1).map((session) => session.sessionId),
  })
  const input = new Map(sessions.map((session) => [session.sessionId as string, session]))
  const load = vi.fn((entity: string, id: string) =>
    entity === 'session' ? input.get(id) : undefined,
  )
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
    summaries: MISSION_VIEW_SUMMARIES,
    load,
    schedule: () => () => {},
  })
  pools.push(pool)
  pool.apply({
    type: 'replace',
    rows: [
      ...[chosenIssue, background].map((value) => ({
        kind: 'issue' as const,
        id: value.id,
        value,
      })),
      ...sessions.map((value) => ({ kind: 'session' as const, id: value.sessionId, value })),
    ],
  })
  pool.header.apply([
    {
      kind: 'repository',
      id: 'menu-repository',
      value: { path: '/synthetic/menu', kind: 'repository', worktrees: [] },
    },
    {
      kind: 'machine',
      id: 'menu-machine',
      value: {
        id: asMachineId('menu-machine'),
        name: 'Menu machine',
        hostname: 'synthetic-menu',
        lastSeenAt: stamp,
        online: true,
      },
    },
  ])
  expect(pool.tables.session.has('chosen-session')).toBe(false)
  return { pool, load }
}

function MenuClick() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Task actions
      </button>
      {open && <PoolIssueContextMenu {...props} />}
    </>
  )
}

it('loads only the selected members in a batch and keeps task menu click work bounded at 1x and 4x', async () => {
  const work: Array<{ rows: number; derivations: number }> = []
  for (const scale of [1, 4]) {
    const { pool, load } = open(scale)
    f.pool = pool
    f.derivations = 0
    const read = vi.spyOn(pool, 'row')
    render(<MenuClick />)
    expect(read).not.toHaveBeenCalled()
    expect(f.derivations).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Task actions' }))
    expect(screen.queryByTestId('pool-task-menu')).toBeNull()
    expect(load).not.toHaveBeenCalled()
    await act(async () => {
      expect(pool.hydrate()).toBe(1)
    })
    expect(screen.getByTestId('pool-task-menu').textContent).toBe('Pool task member')
    expect(load.mock.calls).toEqual([['session', 'chosen-session']])
    expect(
      read.mock.calls
        .filter(([entity]) => entity === 'session')
        .every(([, id]) => id === 'chosen-session'),
    ).toBe(true)
    expect(f.menu?.poolInputs.repos.map((repo) => repo.path)).toEqual(['/synthetic/menu'])
    expect(f.menu?.poolInputs.machines.map((machine) => machine.name)).toEqual(['Menu machine'])
    work.push({ rows: read.mock.calls.length, derivations: f.derivations })
    cleanup()
  }
  expect(work[0]!.rows).toBeGreaterThan(0)
  expect(work[0]!.derivations).toBeGreaterThan(0)
  expect(work[1]!.rows / work[0]!.rows).toBeLessThanOrEqual(1)
  expect(work[1]!.derivations / work[0]!.derivations).toBeLessThanOrEqual(1)
  console.info(
    'POD5438 task menu click counters ' +
      JSON.stringify({ totalSessionRows: [64, 256], visibleNeighbourhood: [3, 3], work }),
  )
})

it('withholds the task menu until pool attachment and drops its inputs on detach', async () => {
  const view = render(<PoolIssueContextMenu {...props} />)
  expect(screen.queryByTestId('pool-task-menu')).toBeNull()
  const { pool } = open(1)
  f.pool = pool
  view.rerender(<PoolIssueContextMenu {...props} />)
  expect(screen.queryByTestId('pool-task-menu')).toBeNull()
  await act(async () => {
    pool.hydrate()
  })
  expect(screen.getByTestId('pool-task-menu').textContent).toBe('Pool task member')
  f.pool = null
  view.rerender(<PoolIssueContextMenu {...props} />)
  expect(screen.queryByTestId('pool-task-menu')).toBeNull()
})
