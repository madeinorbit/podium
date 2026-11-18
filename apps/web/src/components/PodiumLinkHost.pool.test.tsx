import { MobxPool } from '@podium/client-graph'
import { shellViews } from '@podium/client-graph/shell-views'
import type { CollectionLoaderPort, RowRecord, RowSourceEvent } from '@podium/client-graph/shared/source'
import { podiumTargetPath } from '@podium/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../../tests/worklist/harness/src/work-meter'
import { historyLoader } from '../../../../tests/worklist/shared/src/history-loader'

const owner = vi.hoisted(() => ({
  pool: null as MobxPool | null,
  setOpenIssueId: vi.fn(), setView: vi.fn(), navigateToSession: vi.fn(),
  openArtifact: vi.fn(), openFileInWorktree: vi.fn(),
}))
vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPool: () => owner.pool }))
vi.mock('@/app/shell-data', async importOriginal => ({
  ...await importOriginal<typeof import('@/app/shell-data')>(),
  useShellActions: () => ({ httpOrigin: 'http://127.0.0.1:18787',
    setOpenIssueId: owner.setOpenIssueId, setView: owner.setView,
    navigateToSession: owner.navigateToSession, openArtifact: owner.openArtifact,
    openFileInWorktree: owner.openFileInWorktree,
  }),
}))
import { activatePodiumHref, PODIUM_NATIVE_OPEN_EVENT, setKnownPodiumOrigins } from '@/lib/podium-link'
import { PodiumLinkHost } from './PodiumLinkHost'

const old = '2020-01-01T00:00:00Z'
const issue = (id: string, seq: number, patch: object = {}): RowRecord => ({ kind: 'issue', id, value: {
  id, seq, title: id, description: '', stage: 'done', archived: true, repoId: 'repo',
  repoPath: '/fixture', audience: 'human', labels: [], deps: [], priority: 2,
  createdAt: old, updatedAt: old, ...patch,
} } as RowRecord)
const session = (id: string, seq: number): RowRecord => ({ kind: 'session', id, value: {
  sessionId: id, displayRef: `POD-${seq}-A`, title: id, cwd: '/fixture', agentKind: 'codex',
  status: 'exited', archived: true, createdAt: old, lastActiveAt: old,
} } as RowRecord)
// The target's artifact is a record of its own (POD-6764): the link opens it.
const proof = { kind: 'issuePanelArtifact', id: 'target-artifact-0', value: {
  id: 'target-artifact-0', issueId: 'target', position: 0, artifactId: 'proof',
  path: 'proof.html', addedAt: old,
} } as unknown as RowRecord
function fixture(scale: 1 | 4, target = true, loader?: CollectionLoaderPort) {
  const rows: RowRecord[] = [
    { kind: 'worktree', id: 'repo', value: { prefix: 'POD' } } as unknown as RowRecord,
    ...(target ? [issue('target', 1), session('target-seat', 1), proof] : []),
    ...Array.from({ length: scale * 128 }, (_, n) => issue(`foreign-${n}`, n + 2)),
    ...Array.from({ length: scale * 128 }, (_, n) => session(`history-${n}`, n + 2)),
  ]
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse('2026-10-05') }, undefined, {
    load: () => undefined, ...(loader ? { loader: () => loader } : {}),
    worklist: 'demand', schedule: () => () => {},
  })
  pool.apply({ type: 'replace', rows })
  // The lazy runtime installs the shell's pool screen before it exposes the pool.
  shellViews(pool)
  return { pool, publish(event: RowSourceEvent) { pool.apply(event) } }
}

let root: Root, container: HTMLDivElement
const pools: MobxPool[] = []
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
let previousActEnvironment: boolean | undefined
beforeEach(() => {
  previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers(); vi.clearAllMocks(); setKnownPodiumOrigins([])
  container = document.createElement('div'); document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount()); container.remove()
  for (const pool of pools.splice(0)) pool.dispose()
  owner.pool = null; vi.restoreAllMocks(); vi.useRealTimers()
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

it('keeps idle demand zero and first issue/session/artifact activation flat at 1x/4x', async () => {
  async function measured(scale: 1 | 4) {
    const f = fixture(scale); pools.push(f.pool); owner.pool = f.pool
    const refs = vi.spyOn(f.pool.sources, 'view')
    const idle = await measureWork(async () => { await act(async () => { root.render(<PodiumLinkHost />) }) }, { pool: f.pool })
    expect(idle.work.rows).toBe(0)
    const click = await measureWork(async () => insideReader('link clicks', async () => {
      await act(async () => {
        expect(activatePodiumHref('/issues/POD-1')).toBe(true)
        expect(activatePodiumHref('/sessions/POD-1-A')).toBe(true)
        expect(activatePodiumHref(podiumTargetPath({ kind: 'artifact', issue: 'POD-1', artifactId: 'proof', entry: null }))).toBe(true)
      })
    }), { pool: f.pool })
    expect(owner.setOpenIssueId).toHaveBeenCalledWith('target')
    expect(owner.navigateToSession).toHaveBeenCalledWith('target-seat')
    expect(owner.openArtifact).toHaveBeenCalledWith(expect.objectContaining({ issueId: 'target', artifactId: 'proof' }))
    expect(refs.mock.calls.filter(([key]) => key === 'references')).toHaveLength(0)
    await act(async () => { root.render(null) })
    return { idle: idle.work, click: click.work }
  }
  const first = await measured(1), second = await measured(4)
  console.info('production link work 1x/4x', JSON.stringify({ first, second }))
  for (const action of ['idle', 'click'] as const)
    for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(second[action][counter]).toBe(first[action][counter])
})

it('observes only a cold queue head, ignores unrelated updates and releases completed demand', async () => {
  const f = fixture(4, false); pools.push(f.pool); owner.pool = f.pool
  const reads = vi.spyOn(shellViews(f.pool), 'linkedIssue')
  await act(async () => { root.render(<PodiumLinkHost initialHref="http://127.0.0.1:18787/issues/POD-1" />) })
  const before = reads.mock.calls.length
  await act(async () => { f.publish({ type: 'update', rows: [issue('foreign-0', 2, { title: 'Renamed' })] }) })
  expect(reads.mock.calls.length).toBe(before)
  await act(async () => { f.publish({ type: 'update', rows: [issue('target', 1)] }) })
  expect(owner.setOpenIssueId).toHaveBeenCalledWith('target')
  reads.mockClear()
  await act(async () => { f.publish({ type: 'update', rows: [issue('target', 1, { title: 'Later' })] }) })
  expect(reads).not.toHaveBeenCalled()
})

it('releases an expired browser artifact even after its manifest demand has been removed', async () => {
  // The artifact's issue is old work: on the device only as its stub, its row
  // behind the loader, which never answers here.
  const target = issue('target', 1)
  const history = historyLoader([target], [target.value as Record<string, unknown>])
  const f = fixture(4, false, history.port); pools.push(f.pool); owner.pool = f.pool
  const fallback = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
  const reads = vi.spyOn(shellViews(f.pool), 'linkedIssue')
  await act(async () => { root.render(<PodiumLinkHost />) })
  await act(async () => { expect(activatePodiumHref(podiumTargetPath({ kind: 'artifact', issue: 'POD-1', artifactId: 'proof', entry: null }))).toBe(true) })
  expect(history.asked).toEqual([['issue', 'target']])
  expect(fallback).not.toHaveBeenCalled()
  await act(async () => { vi.advanceTimersByTime(5_001) })
  expect(fallback).toHaveBeenCalledOnce()
  reads.mockClear()
  await act(async () => { f.publish({ type: 'update', rows: [issue('target', 1, { title: 'Later' })] }) })
  expect(reads).not.toHaveBeenCalled()
})

it('does not read issue/session rows for file or view queue targets', async () => {
  const f = fixture(4); pools.push(f.pool); owner.pool = f.pool
  await act(async () => { root.render(<PodiumLinkHost />) })
  const rows = vi.spyOn(f.pool, 'row')
  await act(async () => {
    window.dispatchEvent(new CustomEvent(PODIUM_NATIVE_OPEN_EVENT, { detail: 'podium://usage' }))
    activatePodiumHref(podiumTargetPath({ kind: 'file', path: 'a.ts', root: '/w', machineId: null }))
  })
  expect(rows).not.toHaveBeenCalled()
})
