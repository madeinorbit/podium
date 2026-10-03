import type { SessionView } from '@podium/client-core/session-values'
import { MobxPool } from '@podium/client-graph'
import { MISSION_VIEW_SUMMARIES } from '@podium/client-graph/mission-view-schema'
import { asIssueId, asMachineId, asSessionId } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { PoolSessionContextMenu } from './PoolSessionContextMenu'
import type { SessionContextMenuProps } from './SessionContextMenu'

const f = vi.hoisted(() => ({
  pool: null as MobxPool | null,
  derivations: 0,
  menu: null as SessionContextMenuProps | null,
}))
vi.mock('@podium/client-core/react', () => {
  const owner = {
    getSnapshot: () => {
      throw new Error('Menu reader reached the old store')
    },
  }
  return { useStoreHandle: () => owner }
})
vi.mock('./SessionContextMenu', () => ({
  SessionContextMenu: (props: SessionContextMenuProps) => {
    f.menu = props
    return <output data-testid="pool-session-menu">{props.session.title}</output>
  },
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
            ? createPoolProjection(pool, (owner) => {
                f.derivations++
                return read(owner)
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
const row = (id: string, issueId: string): SessionView => ({
  sessionId: asSessionId(id),
  cwd: '/synthetic/menu',
  title: 'Pool session',
  agentKind: 'codex',
  status: 'exited',
  controllerId: null,
  geometry: { cols: 80, rows: 24 },
  epoch: 0,
  clientCount: 0,
  origin: { kind: 'spawn' },
  archived: true,
  readAt: null,
  unread: false,
  issueId: asIssueId(issueId),
  createdAt: stamp,
  lastActiveAt: stamp,
})
function open(scale: number) {
  const chosen = row('chosen-session', 'chosen-issue')
  const seats = [
    chosen,
    ...Array.from({ length: 64 * scale - 1 }, (_, i) => row(`unrelated-${i}`, 'background-issue')),
  ]
  const issues = ['chosen-issue', 'background-issue'].map((id) =>
    makeIssue({
      id,
      audience: 'agent',
      stage: 'done',
      closedAt: '2026-09-20T12:00:00Z',
      updatedAt: '2026-09-20T12:00:00Z',
    }),
  )
  const input = new Map<string, object>([
    ...seats.map((seat) => [`session:${seat.sessionId}`, seat] as const),
    ...issues.map((issue) => [`issue:${issue.id}`, issue] as const),
  ])
  const load = vi.fn((entity: string, id: string) => input.get(`${entity}:${id}`))
  const pool = new MobxPool({ coarseNow: Date.parse(stamp), selectedIssueId: null }, undefined, {
    load,
    summaries: MISSION_VIEW_SUMMARIES,
    schedule: () => () => {},
  })
  pools.push(pool)
  pool.apply({
    type: 'replace',
    rows: [
      ...issues.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
      ...seats.map((value) => ({ kind: 'session' as const, id: value.sessionId, value })),
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
  expect(pool.tables.issue.has('chosen-issue')).toBe(false)
  return { pool, load }
}
const props = {
  sessionId: asSessionId('chosen-session'),
  anchor: { x: 10, y: 10 },
  onClose: () => {},
  onRename: () => {},
}

function MenuClick() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Session actions
      </button>
      {open && <PoolSessionContextMenu {...props} />}
    </>
  )
}

it('batches the addressed cold session and supplies pool inputs with equal click work at 1x and 4x', async () => {
  const work: Array<{ rows: number; derivations: number }> = []
  for (const scale of [1, 4]) {
    const { pool, load } = open(scale)
    f.pool = pool
    f.derivations = 0
    const read = vi.spyOn(pool, 'row')
    render(<MenuClick />)
    expect(read).not.toHaveBeenCalled()
    expect(f.derivations).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }))
    expect(screen.queryByTestId('pool-session-menu')).toBeNull()
    expect(load).not.toHaveBeenCalled()
    await act(async () => {
      expect(pool.hydrate()).toBe(1)
    })
    expect(screen.queryByTestId('pool-session-menu')).toBeNull()
    await act(async () => {
      expect(pool.hydrate()).toBe(1)
    })
    expect(screen.getByTestId('pool-session-menu').textContent).toBe('Pool session')
    expect(load.mock.calls).toEqual([
      ['session', 'chosen-session'],
      ['issue', 'chosen-issue'],
    ])
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
    'POD5438 menu click counters ' +
      JSON.stringify({ totalSessionRows: [64, 256], visibleNeighbourhood: [4, 4], work }),
  )
})

it('waits for pool attachment and drops obsolete menu inputs when the pool detaches', async () => {
  const view = render(<PoolSessionContextMenu {...props} />)
  expect(screen.queryByTestId('pool-session-menu')).toBeNull()
  const { pool } = open(1)
  f.pool = pool
  view.rerender(<PoolSessionContextMenu {...props} />)
  expect(screen.queryByTestId('pool-session-menu')).toBeNull()
  await act(async () => {
    pool.hydrate()
  })
  expect(screen.queryByTestId('pool-session-menu')).toBeNull()
  await act(async () => {
    pool.hydrate()
  })
  expect(screen.getByTestId('pool-session-menu').textContent).toBe('Pool session')
  f.pool = null
  view.rerender(<PoolSessionContextMenu {...props} />)
  expect(screen.queryByTestId('pool-session-menu')).toBeNull()
})
