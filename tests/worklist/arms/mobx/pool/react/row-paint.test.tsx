// @vitest-environment happy-dom
import { MobxPool } from '@podium/client-graph/pool'
import type { SidebarRowValues } from '@podium/client-graph/worklist/sidebar-row'
import { observable, runInAction } from 'mobx'
import { act, Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { poolIssuePaint } from '../../../../../../apps/web/src/features/worklist/pool-row-data'
import { PoolRow } from './row'

const planted = vi.hoisted(() => ({ read: (): unknown => undefined }))
vi.mock('@podium/client-graph/worklist/sidebar', async importOriginal => ({
  ...await importOriginal<typeof import('@podium/client-graph/worklist/sidebar')>(),
  sidebarValues: () => planted.read(),
}))

const stamp = '2026-10-06T12:00:00Z'

/** Only the addressed reader is planted. The observer, computed and real
 * web paint projection stay intact, and the model's coarse fields stay fixed. */
function payload(): SidebarRowValues {
  return {
    idNumber: 1, color: null, title: 'Ancestor',
    timing: { phase: 'working', sinceMs: 10, baseMs: 20, totalMs: 30 },
    working: true, asking: false,
    originTick: { id: 'origin', seq: 2, title: 'Origin', ref: 'SYN-2' },
    decision: null, mergeCommits: 0,
    progress: { done: 1, run: 1, review: 1, stall: 1, block: 1, wait: 1, total: 6 },
    fromChildren: true, statusFromChildren: true,
    gitState: undefined, unread: false, errorClass: null, internal: false,
    unsnoozed: false, deferred: false, awaitsTuck: false, canBringBack: false,
    draftAgentOnly: false, firstSessionId: 'seat', continuation: null,
    fleet: { total: 1, parkedCount: 0, nativeCount: 0, tiles: [{ kind: 'codex', parked: false }] },
    issue: {
      id: 'ancestor', seq: 1, displayRef: 'SYN-1', linearIdentifier: 'EXT-1', title: 'Ancestor',
      audience: 'human', color: '#112233', branch: 'issue/ancestor',
      gitState: { ahead: 1, behind: 0, merged: false } as SidebarRowValues['gitState'],
      stage: 'planning', closedReason: null, closedAt: null, needsHuman: false, asked: null,
      repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp,
    },
    sessions: [], aggregateSessionIds: ['seat'], awaitingFirstPrompt: false,
  }
}

function leaves(value: unknown, path: string[] = []): string[][] {
  if (value === null || typeof value !== 'object') return [path]
  return Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, key]))
}

function at(value: unknown, path: readonly string[]): unknown {
  for (const key of path) value = (value as Record<string, unknown>)[key]
  return value
}

function put(value: unknown, path: readonly string[], next: unknown): void {
  const parent = at(value, path.slice(0, -1)) as Record<string, unknown>
  parent[path.at(-1)!] = next
}

function changePaintField(base: SidebarRowValues, path: readonly string[]): SidebarRowValues {
  const next = structuredClone(base)
  let source = [...path]
  if (source[0] === 'display') source.shift()
  if (source[0] === 'origin') source[0] = 'originTick'
  if (source[0] === 'errorLine') {
    next.errorClass = 'unknown'
    return next
  }
  if (source[0] === 'statusLine') {
    next.continuation = { kind: 'continued', ref: 'SYN-3' }
    return next
  }
  const previous = at(base, source)
  const changed = typeof previous === 'boolean' ? !previous
    : typeof previous === 'number' ? previous + 1
      : typeof previous === 'string' ? `${previous}-planted` : 'planted'
  put(next, source, changed)
  return next
}

function mount(base: SidebarRowValues) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: 'ancestor', value: {
    id: 'ancestor', seq: 1, title: 'Ancestor', stage: 'planning', audience: 'human',
    repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp,
  } }] })
  const value = observable.box(base, { deep: false })
  planted.read = () => value.get()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const commits = vi.fn()
  act(() => root.render(
    <Profiler id="ancestor" onRender={commits}>
      <PoolRow row={pool.issueObject('ancestor')} />
    </Profiler>,
  ))
  commits.mockClear()
  return {
    commits,
    change(next: SidebarRowValues) { act(() => runInAction(() => value.set(next))) },
    dispose() { act(() => root.unmount()); container.remove(); pool.dispose(); planted.read = () => undefined },
  }
}

// Generated from the PRODUCT paint result: every display/timer/fleet field,
// title, all progress buckets, origin, tuck/first-session facts and issue facts.
const fields = leaves(poolIssuePaint(payload())).map(path => ({ name: path.join('.'), path }))
it.each(fields)('redraws the harness ancestor for displayed $name', ({ path }) => {
  const base = payload()
  const next = changePaintField(base, path)
  expect(at(poolIssuePaint(next), path)).not.toEqual(at(poolIssuePaint(base), path))
  const row = mount(base)
  try { row.change(next); expect(row.commits).toHaveBeenCalledTimes(1) }
  finally { row.dispose() }
})

it('redraws when the last formal child changes fromChildren/statusFromChildren with equal totals', () => {
  const base = payload()
  const next = { ...base, fromChildren: false, statusFromChildren: false }
  expect(poolIssuePaint(next).display.statusLine).not.toBe(poolIssuePaint(base).display.statusLine)
  const row = mount(base)
  try { row.change(next); expect(row.commits).toHaveBeenCalledTimes(1) }
  finally { row.dispose() }
})

it('suppresses an unchanged paint when navigation-only facts change', () => {
  const base = payload()
  const next = { ...base, canBringBack: true, aggregateSessionIds: ['another-seat'] }
  expect(poolIssuePaint(next)).toEqual(poolIssuePaint(base))
  const row = mount(base)
  try { row.change(next); expect(row.commits).not.toHaveBeenCalled() }
  finally { row.dispose() }
})
