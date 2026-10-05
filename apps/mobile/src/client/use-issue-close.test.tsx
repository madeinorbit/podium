import { MobxPool } from '@podium/client-graph/pool'
import { ISSUE_PAGE_SUMMARIES } from '@podium/client-graph/issue-page-schema'
import { createColdIndex } from '@podium/client-graph/shared/cold-index'
import { SCHEMA } from '@podium/client-graph/shared/schema'
import type { RowRecord, RowSourceEvent } from '@podium/client-graph/shared/source'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../../packages/worklist-proto/harness/src/work-meter'

const state = vi.hoisted(() => ({ pool: null as MobxPool | null }))
vi.mock('./mobile-pool', async () => {
  const { useMemo, useSyncExternalStore } = await import('react')
  const { createPoolProjection } = await import('@podium/client-graph/runtime-pool')
  return {
    useMobilePool: () => state.pool,
    useMobilePoolProjection: <T,>(read: (pool: MobxPool) => T, empty: T): T => {
      const pool = state.pool
      const view = useMemo(() => pool ? createPoolProjection(pool, read) : null, [pool, read])
      return useSyncExternalStore(view?.subscribe ?? (() => () => {}), () => view ? view.getSnapshot() : empty)
    },
  }
})
const { readIssueCloseConcerns, useIssueCloseConcerns, useIssueCloseGuard } = await import('./use-issue-close')
afterEach(() => { cleanup(); state.pool?.dispose(); state.pool = null; vi.restoreAllMocks() })
const stamp = '2020-01-01T00:00:00Z'
const issue = (id: string, patch: object = {}): RowRecord => ({ kind: 'issue', id, value: {
  id, seq: 1, title: id, description: '', stage: 'planning', parentBranch: 'main', repoPath: '/fixture',
  audience: 'human', labels: [], deps: [], priority: 2, createdAt: stamp, updatedAt: stamp, ...patch,
} } as RowRecord)
const session = (id: string, patch: object = {}): RowRecord => ({ kind: 'session', id, value: {
  sessionId: id, issueId: 'target', title: id, agentKind: 'codex', status: 'live', cwd: '/fixture',
  createdAt: stamp, lastActiveAt: stamp, archived: false, agentState: { phase: 'working', since: stamp }, ...patch,
} } as RowRecord)
function fixture(scale: 1 | 4) {
  const rows = [issue('target'), session('target-seat'),
    ...Array.from({ length: scale * 128 }, (_, i) => issue(`foreign-${i}`, { archived: true })),
    ...Array.from({ length: scale * 128 }, (_, i) => session(`foreign-seat-${i}`, { issueId: `foreign-${i}`, archived: true, status: 'exited' })),
  ]
  const source = createColdIndex(SCHEMA, ISSUE_PAGE_SUMMARIES)
  source.apply({ type: 'replace', rows })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse('2026-10-05') }, undefined, {
    cold: () => source, load: () => undefined, summaries: ISSUE_PAGE_SUMMARIES, worklist: 'demand', schedule: () => () => {},
  })
  pool.apply({ type: 'replace', rows }); state.pool = pool
  return { pool, publish(event: RowSourceEvent) { source.apply(event); pool.apply(event) } }
}
function Probe() {
  const guard = useIssueCloseGuard()
  return <button type="button" onClick={() => { result = guard('target') }}>Close check</button>
}
let result = false

it('keeps unsettled or missing task facts guarded', () => {
  render(<Probe />)
  fireEvent.click(screen.getByText('Close check')); expect(result).toBe(true)
  const f = fixture(1)
  expect(readIssueCloseConcerns(f.pool, 'missing')).toBe(LOADING)
})

it('mounts the action guard without row demand and reads current counts on each press at 1x/4x', async () => {
  async function measured(scale: 1 | 4) {
    const f = fixture(scale), row = vi.spyOn(f.pool, 'row'), ids = vi.spyOn(f.pool.queries, 'ids')
    render(<Probe />)
    expect(row).not.toHaveBeenCalled(); expect(ids).not.toHaveBeenCalled()
    const press = await measureWork(async () => insideReader('phone close press', () => fireEvent.click(screen.getByText('Close check'))), { pool: f.pool })
    expect(result).toBe(true)
    act(() => f.publish({ type: 'update', rows: [session('target-seat', { agentState: { phase: 'idle', since: stamp } })] }))
    fireEvent.click(screen.getByText('Close check')); expect(result).toBe(false)
    expect(row.mock.calls.every(([kind, id]) => kind === 'issue' ? id === 'target' : kind === 'session' && id === 'target-seat')).toBe(true)
    expect(ids).not.toHaveBeenCalled()
    cleanup(); f.pool.dispose(); state.pool = null
    return press.work
  }
  const first = await measured(1), second = await measured(4)
  console.info('phone close press work1x4x', JSON.stringify({ first, second }))
  for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const) expect(second[counter]).toBe(first[counter])
})

it('observes only the open task and releases its scalar demand on unmount at 1x/4x', async () => {
  async function measured(scale: 1 | 4) {
    const f = fixture(scale), read = vi.fn()
    function Open() {
      read()
      const concerns = useIssueCloseConcerns('target')
      return <div>{concerns === LOADING ? 'Loading' : concerns.map(concern => concern.label).join(',')}</div>
    }
    const view = render(<Open />), row = vi.spyOn(f.pool, 'row')
    read.mockClear()
    const unrelated = await measureWork(async () => insideReader('phone close unrelated', () => act(() => {
      f.publish({ type: 'update', rows: [session('foreign-seat-0', { issueId: 'foreign-0', archived: true, status: 'exited', title: 'Rename' })] })
    })), { pool: f.pool })
    expect(read).not.toHaveBeenCalled()
    expect(row.mock.calls.every(([kind, id]) => kind === 'session' && id === 'foreign-seat-0')).toBe(true)
    act(() => f.publish({ type: 'update', rows: [session('target-seat', { agentState: { phase: 'idle', since: stamp } })] }))
    expect(read).toHaveBeenCalledTimes(1)
    view.unmount(); read.mockClear()
    act(() => f.publish({ type: 'update', rows: [session('target-seat')] }))
    expect(read).not.toHaveBeenCalled()
    f.pool.dispose(); state.pool = null
    return unrelated.work
  }
  const first = await measured(1), second = await measured(4)
  console.info('phone close unrelated work1x4x', JSON.stringify({ first, second }))
  for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const) expect(second[counter]).toBe(first[counter])
})
