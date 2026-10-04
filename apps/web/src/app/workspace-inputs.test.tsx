// @vitest-environment happy-dom

import { MobxPool } from '@podium/client-graph'
import { sessionPaneFixture } from '@podium/client-graph/diagnostics/session-pane-fixture'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { createColdIndex } from '@podium/client-graph/shared/cold-index'
import { SCHEMA } from '@podium/client-graph/shared/schema'
import type { RowRecord } from '@podium/client-graph/shared/source'
import { SHELL_SUMMARIES } from '@podium/client-graph/shell-schema'
import { asSessionId, type SessionId } from '@podium/model/browser'
import { act, cleanup, render } from '@testing-library/react'
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useWarmSet } from '@/features/terminal/use-warm-set'

vi.mock('./store-worklist-pool', () => ({ useWorklistPoolProjection: () => null }))
const { workspaceSessions, readOrphanWorkspaceSession, pendingWorkspaceIssueHasSession } =
  await import('./workspace-inputs')

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanup()
  for (const dispose of cleanups.splice(0).reverse()) dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fixture(size = 128) {
  const base = sessionPaneFixture()[0]
  if (!base) throw new Error('Missing synthetic pane fixture')
  const session = (id: string, patch: object = {}): RowRecord => ({
    kind: 'session',
    id,
    value: {
      ...base,
      sessionId: asSessionId(id),
      cwd: '/synthetic/worktree',
      issueId: 'wanted',
      title: id,
      ...patch,
    },
  })
  const rows = Array.from({ length: size }, (_, at) =>
    session(`unvisited-${at}`, {
      issueId: 'foreign',
      status: 'exited',
      archived: true,
      createdAt: '2020-01-01T00:00:00Z',
      stoppedAt: '2020-01-01T00:00:00Z',
      lastActiveAt: '2020-01-01T00:00:00Z',
      readAt: '2020-01-02T00:00:00Z',
    }),
  )
  rows.push(session('a'), session('b'), session('foreign-warm', { issueId: 'foreign' }))
  const source = createColdIndex(SCHEMA, SHELL_SUMMARIES)
  source.apply({ type: 'replace', rows })
  const load = vi.fn(
    (entity: string, id: string) => rows.find((row) => row.kind === entity && row.id === id)?.value,
  )
  const pool = new MobxPool(
    { selectedIssueId: null, coarseNow: Date.parse('2026-10-04T12:00:00Z') },
    undefined,
    {
      cold: () => source,
      summaries: SHELL_SUMMARIES,
      load,
      schedule: () => () => {},
    },
  )
  pool.apply({ type: 'replace', rows })
  cleanups.push(() => pool.dispose())
  return {
    pool,
    load,
    session,
    publish: (records: RowRecord[]) => {
      const event = { type: 'update' as const, rows: records }
      source.apply(event)
      pool.apply(event)
    },
  }
}

it.each([
  128, 512,
])('reads only current and retained identities with %i unrelated sessions', (size) => {
  const f = fixture(size),
    read = vi.spyOn(f.pool, 'row'),
    ids = vi.spyOn(f.pool.queries, 'ids')
  expect(
    workspaceSessions(f.pool, new Set(['b', 'a', 'file-tab']), ['foreign-warm', 'a']).map(
      (row) => row.sessionId,
    ),
  ).toEqual(['b', 'a', 'foreign-warm'])
  expect(read.mock.calls.map((call) => call[1])).toEqual([
    'b',
    'b',
    'a',
    'a',
    'file-tab',
    'foreign-warm',
  ])
  expect(ids).not.toHaveBeenCalled()
  expect(f.load).not.toHaveBeenCalled()
})

it('keeps foreign warm panels through issue switches and drops addressed archive/removal updates', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const f = fixture()
  function Panels({ active }: { active: SessionId }) {
    const retained = useRef<SessionId[]>([])
    const retainedIds = retained.current
    const read = useCallback(
      (pool: MobxPool) => workspaceSessions(pool, new Set([active]), retainedIds),
      [active, retainedIds],
    )
    const projection = useMemo(() => createPoolProjection(f.pool, read), [read])
    const sessions = useSyncExternalStore(projection.subscribe, projection.getSnapshot)
    const eligible = sessions.filter((row) => !row.archived).map((row) => row.sessionId)
    const warm = useWarmSet(eligible, [active], retained)
    return <output>{[...warm].sort().join(',')}</output>
  }
  const view = render(<Panels active={asSessionId('a')} />)
  view.rerender(<Panels active={asSessionId('b')} />)
  expect(view.container.textContent).toBe('a,b')
  view.rerender(<Panels active={asSessionId('a')} />)
  expect(view.container.textContent).toBe('a,b')
  act(() => f.publish([f.session('b', { archived: true })]))
  expect(view.container.textContent).toBe('a')
  view.rerender(<Panels active={asSessionId('foreign-warm')} />)
  expect(view.container.textContent).toBe('a,foreign-warm')
  act(() => f.publish([{ kind: 'session', id: 'a', value: undefined }]))
  expect(view.container.textContent).toBe('foreign-warm')
})

it('preserves source resume collapse for addressed tabs and foreign warm sessions', () => {
  const f = fixture()
  const resume = { kind: 'codex-thread', value: 'synthetic-twin' }
  f.publish([
    f.session('a', { resume, status: 'exited' }),
    f.session('b', { resume, status: 'live' }),
  ])
  // A group with an active process stays whole; only a parked group collapses.
  expect(workspaceSessions(f.pool, new Set(['a', 'b'])).map((row) => row.sessionId)).toEqual([
    'a',
    'b',
  ])
  f.publish([f.session('b', { resume, status: 'hibernated' })])
  expect(f.pool.queries.collapsed('a')).toBe(true)
  expect(workspaceSessions(f.pool, new Set(['a', 'b']), ['a']).map((row) => row.sessionId)).toEqual(
    ['b'],
  )
})

it('discovers deleted-worktree orphans in source order, with the current pane preferred', () => {
  const f = fixture()
  f.publish([
    f.session('a', { cwd: '/synthetic/gone/subdir' }),
    f.session('b', { cwd: '/synthetic/gone' }),
  ])
  expect(readOrphanWorkspaceSession(f.pool, '/synthetic/gone', 'b')?.sessionId).toBe('b')
  expect(readOrphanWorkspaceSession(f.pool, '/synthetic/gone', null)?.sessionId).toBe('a')
  expect(readOrphanWorkspaceSession(f.pool, '/synthetic/gone-other', null)).toBeNull()
})

it('checks pending launch membership outside the tab roster, including shell seats', () => {
  const f = fixture(),
    ids = vi.spyOn(f.pool.queries, 'ids')
  expect(pendingWorkspaceIssueHasSession(f.pool, '')).toBe(false)
  expect(ids).not.toHaveBeenCalled()
  f.publish([f.session('untabbed-shell', { issueId: 'launch', agentKind: 'shell' })])
  expect(pendingWorkspaceIssueHasSession(f.pool, 'launch')).toBe(true)
  expect(pendingWorkspaceIssueHasSession(f.pool, 'missing')).toBe(false)
  expect(ids.mock.calls.every(([question]) => question.kind === 'commandIssueSessions')).toBe(true)
})
