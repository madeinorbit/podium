import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { MobxPool } from '../pool'
import { worklistView } from './view-model'
import { fleetOf, sidebarTiming } from './sidebar-row'
import type { SliceSession } from '../shared/slice-types'
import { insideArm, insideReader, measureWork } from '../../../../tests/worklist/harness/src/work-meter'

const stamp = '2026-10-09T07:00:00Z', lane = '/synthetic/lane'
const sender = (sessionId: string, archived = false) => ({ sessionId, cwd: lane,
  agentKind: 'codex', status: archived ? 'exited' : 'live', archived,
  createdAt: stamp, lastActiveAt: archived ? '2026-01-01T00:00:00Z' : stamp,
  agentState: { phase: 'idle', since: stamp, idle: { kind: 'done' }, workingMsTotal: 42 } })

async function measure(history: number, legacy: boolean, hidden = false) {
  const pool = new MobxPool({ coarseNow: Date.parse(stamp) })
  const live = ['a', 'b', 'c'].map(id => sender(id))
  pool.apply({ type: 'replace', rows: [
    { kind: 'worktree', id: lane, value: { path: lane, repoPath: '/synthetic' } },
    ...[...live, ...Array.from({ length: history }, (_, n) => sender(`old-${n}`, true))]
      .map(row => ({ kind: 'session' as const, id: row.sessionId, value: row as never })),
  ] })
  const tree = worklistView(pool).tree(pool.model('worktree', lane)!)
  const stop = autorun(() => insideReader('owner totals', () => {
    if (legacy) {
      const shown = tree.sessions as unknown as SliceSession[]
      void sidebarTiming(shown, tree.visiblePhase, false, tree.activityAt)
      void fleetOf(shown)
    } else { void tree.timing; void tree.visibleFleet }
    void tree.visibleUnread; void tree.waitingCount
  }))
  if (hidden) { stop(); await Promise.resolve(); await Promise.resolve() }
  const spies = live.map(row => vi.spyOn(pool.sessionObject(row.sessionId), 'storedField'))
  try {
    const result = await measureWork(async () => insideArm(() => runInAction(() => pool.apply({
      type: 'update', rows: [{ kind: 'session', id: 'a', value: { ...live[0],
        lastActiveAt: '2026-10-09T07:01:00Z',
        agentState: { ...live[0]!.agentState, workingMsTotal: 99 },
      } as never }],
    }))), { pool })
    const peers = spies.slice(1).reduce((count, spy) => count + spy.mock.calls.filter(([field]) => field === 'agentState').length, 0)
    const timerBodies = Object.entries(result.work.derivationsBy).filter(([name]) => /WorklistWorktree.*(Timer|Timing|Fleet|workingMsTotal|doneSinceMs)/.test(name))
      .reduce((count, [, value]) => count + value, 0)
    return { work: result.work, peers, timerBodies }
  } finally { spies.forEach(spy => spy.mockRestore()); if (!hidden) stop(); pool.dispose() }
}

it('remeasures old roster reads and updates only the changed session fact', async () => {
  const old = await measure(32, true), next = await measure(32, false)
  expect(old.peers).toBeGreaterThan(0)
  expect(next.peers).toBe(0)
  expect(next.timerBodies).toBeGreaterThan(0)
  console.info('owner raw unchanged-peer reads', { old: old.peers, next: next.peers })
})

it('member heartbeat work is flat at 1x and 4x archived owner history', async () => {
  const one = await measure(32, false), four = await measure(128, false)
  for (const kind of ['rows', 'derivations', 'elements'] as const) expect(four.work[kind], kind).toBe(one.work[kind])
  expect({ one: one.peers, four: four.peers }).toEqual({ one: 0, four: 0 })
  const counts = (work: typeof one.work) => ({ rows: work.rows, derivations: work.derivations, elements: work.elements })
  console.info('owner heartbeat work', { one: counts(one.work), four: counts(four.work) })
})

it('a hidden owner row runs no timing or fleet total and reads no peer facts', async () => {
  for (const history of [32, 128]) {
    const result = await measure(history, false, true)
    expect(result.timerBodies).toBe(0)
    expect(result.peers).toBe(0)
  }
})
