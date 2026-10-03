import type { ClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { LOADING, MobxPool } from '@podium/client-graph'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import { asUserId } from '@podium/model/browser'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachWorklistPool, useWorklistPool } from '@/app/store-worklist-pool'
import { createSidebarFixture } from '../../../test/sidebar-fixture'
import { useHasFirstTask } from './mobile-handoff'

const mode = vi.hoisted(() => ({ value: 'pool' as 'legacy' | 'pool', legacyReads: 0 }))
vi.mock('@/app/store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/app/store')>()
  return {
    ...original,
    useReplicaIssues: () => {
      mode.legacyReads += 1
      if (mode.value === 'pool') throw new Error('Pool first-task check read legacy issue models')
      return original.useReplicaIssues()
    },
  }
})

const NOW = Date.parse('2026-10-01T08:00:00Z')
const pools: MobxPool[] = []
beforeEach(() => {
  mode.value = 'pool'
  mode.legacyReads = 0
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  for (const pool of pools.splice(0)) pool.dispose()
  vi.restoreAllMocks()
})

function issue(patch: Partial<SliceIssue> = {}): SliceIssue {
  return {
    id: 'first-task',
    seq: 1,
    title: 'First task',
    stage: 'in_progress',
    createdAt: new Date(NOW - 86400000).toISOString(),
    updatedAt: new Date(NOW - 3600000).toISOString(),
    repoPath: '/synthetic/project',
    audience: 'human',
    ...patch,
  }
}

function makePool(rows: SliceIssue[], lazy = true) {
  const source = new Map(rows.map((row) => [row.id, row]))
  const load = vi.fn((_kind: string, id: string) => source.get(id))
  const schedule = vi.fn(() => () => {})
  const pool = new MobxPool(
    { selectedIssueId: null, coarseNow: NOW },
    undefined,
    lazy ? { load, schedule } : undefined,
  )
  pools.push(pool)
  pool.apply({
    type: 'replace',
    rows: rows.map((value) => ({ kind: 'issue', id: value.id, value })),
  })
  return { pool, load, source, schedule }
}

describe('declared pool first-task value', () => {
  it.each([
    ['archived', { archived: true }, true],
    ['draft', { isDraftVessel: true }, true],
    ['deleted', { deletedAt: new Date(NOW).toISOString() }, false],
    ['empty deletion stamp', { deletedAt: '' }, true],
  ] as const)('preserves the predicate for %s-only data without loading cold rows', (_name, patch, expected) => {
    const { pool, load } = makePool([issue(patch)])
    const model = vi.spyOn(pool, 'issueObject')
    expect(pool.hasFirstTask).toBe(expected)
    expect(load).not.toHaveBeenCalled()
    expect(model).not.toHaveBeenCalled()
    if (_name === 'archived' || _name === 'deleted') expect(pool.tables.issue.size).toBe(0)
  })

  it('returns false for an empty pool', () => {
    expect(makePool([]).pool.hasFirstTask).toBe(false)
  })

  it('reads the maintained value without walking resident or cold history', () => {
    const { pool } = makePool([issue(), issue({ id: 'second-task' })], false)
    const read = vi.spyOn(pool, 'row')
    const coldIds = vi.spyOn(pool.residency ?? { ids: () => [] }, 'ids')
    expect(pool.hasFirstTask).toBe(true)
    expect(read).not.toHaveBeenCalled()
    expect(coldIds).not.toHaveBeenCalled()
  })

  it('keeps a missing cold summary LOADING and batches the row load', () => {
    const archived = issue({ archived: true })
    const { pool, source, load, schedule } = makePool([])
    vi.spyOn(pool.residency!, 'summary').mockReturnValue(undefined)
    source.set(archived.id, archived)
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: archived.id, value: archived }] })
    expect(pool.hasFirstTask).toBe(LOADING)
    expect(pool.hasFirstTask).toBe(LOADING)
    expect(load).not.toHaveBeenCalled()
    expect(schedule).toHaveBeenCalledOnce()
    expect(pool.hydrate()).toBe(1)
    expect(load).toHaveBeenCalledOnce()
    expect(pool.hasFirstTask).toBe(true)
  })

  it('tracks cold summary changes, eviction, and replacement without retaining a task', () => {
    const archived = issue({ archived: true })
    const { pool, source, load } = makePool([archived])
    const projection = createPoolProjection(pool, (owner) => owner.hasFirstTask)
    const wake = vi.fn()
    const stop = projection.subscribe(wake)
    try {
      expect(projection.getSnapshot()).toBe(true)
      const deleted = { ...archived, deletedAt: new Date(NOW).toISOString() }
      source.set(deleted.id, deleted)
      pool.apply({ type: 'update', rows: [{ kind: 'issue', id: deleted.id, value: deleted }] })
      expect(projection.getSnapshot()).toBe(false)
      source.set(archived.id, archived)
      pool.apply({ type: 'update', rows: [{ kind: 'issue', id: archived.id, value: archived }] })
      expect(projection.getSnapshot()).toBe(true)
      pool.apply({ type: 'update', rows: [{ kind: 'issue', id: archived.id, value: undefined }] })
      expect(projection.getSnapshot()).toBe(false)
      pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: archived.id, value: archived }] })
      expect(projection.getSnapshot()).toBe(true)
      pool.apply({ type: 'replace', rows: [] })
      expect(projection.getSnapshot()).toBe(false)
      expect(load).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })

  it('does not recompute task existence on selection or an unrelated heartbeat', () => {
    const { pool } = makePool([issue()])
    const read = vi.spyOn(pool, 'hasFirstTask', 'get')
    const projection = createPoolProjection(pool, (owner) => owner.hasFirstTask)
    const stop = projection.subscribe(() => {})
    read.mockClear()
    try {
      pool.applyLocals(
        { selectedIssueId: 'first-task', coarseNow: NOW },
        new Set(['selectedIssueId']),
      )
      pool.apply({
        type: 'update',
        rows: [
          {
            kind: 'session',
            id: 'unrelated',
            value: {
              sessionId: 'unrelated',
              cwd: '/unrelated',
              lastActiveAt: new Date(NOW).toISOString(),
            },
          },
        ],
      })
      expect(projection.getSnapshot()).toBe(true)
      expect(read).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })
})

describe('first-task startup switch', () => {
  it.each([
    ['archived', { archived: true }, true],
    ['draft', { isDraftVessel: true }, true],
    ['deleted', { deletedAt: new Date(NOW).toISOString() }, false],
  ] as const)('reads %s-only data from the existing runtime pool with zero legacy calls', async (_name, patch, expected) => {
    const fixture = createSidebarFixture(1, NOW, true, 'promo-test')
    fixture.patch('issueProjection', 'synthetic-0', patch)
    let runtime: ClientRuntime | undefined
    let pool: MobxPool | null = null
    function Capture() {
      runtime = useStoreHandle() as ClientRuntime
      pool = useWorklistPool()
      return null
    }
    function Presence({ name }: { name: string }) {
      return <output data-testid={name}>{String(useHasFirstTask())}</output>
    }
    render(
      <StoreProvider
        principal={asClientPrincipal(asUserId('promo-test'))}
        config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
        api={fixture.api}
        createReplicaFn={() => fixture.replica}
        networkEnabled={false}
        onFatalError={(message) => {
          throw new Error(message)
        }}
        attachRuntime={(owner) =>
          attachWorklistPool(owner, (error) => {
            throw error
          })
        }
      >
        <Capture />
        <Presence name="card" />
        <Presence name="chip" />
      </StoreProvider>,
    )
    await waitFor(() => expect(pool).not.toBeNull())
    for (const name of ['card', 'chip'])
      expect(screen.getByTestId(name).textContent).toBe(String(expected))
    await act(async () => {
      runtime!.getSnapshot().setSelectedIssueId('synthetic-0' as never)
      fixture.patch('session', 'synthetic-session-0', {
        lastActiveAt: new Date(NOW + 1000).toISOString(),
      })
    })
    for (const name of ['card', 'chip'])
      expect(screen.getByTestId(name).textContent).toBe(String(expected))
    expect(mode.legacyReads).toBe(0)
  })
})
