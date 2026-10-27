import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import {
  insideArm,
  insideReader,
  measureWork,
} from '../../../../tests/worklist/harness/src/work-meter'
import { requireHere } from '../lookup'
import { MobxPool } from '../pool'
import type { SliceSession } from '../shared/slice-types'
import { fleetOf, sidebarTiming } from './sidebar-row'
import { worklistView } from './view-model'

const stamp = '2026-10-09T07:00:00Z',
  lane = '/synthetic/lane'
const sender = (sessionId: string, archived = false) => ({
  sessionId,
  cwd: lane,
  agentKind: 'codex',
  status: archived ? 'exited' : 'live',
  archived,
  createdAt: stamp,
  lastActiveAt: archived ? '2026-01-01T00:00:00Z' : stamp,
  unread: sessionId === 'c',
  agentState: { phase: 'idle', since: stamp, idle: { kind: 'done' }, workingMsTotal: 42 },
})

async function measure(history: number, legacy: boolean, hidden = false, readState = false) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  const live = ['a', 'b', 'c'].map((id) => sender(id))
  pool.apply({
    type: 'replace',
    rows: [
      { kind: 'worktree', id: lane, value: { path: lane, repoPath: '/synthetic' } },
      ...[...live, ...Array.from({ length: history }, (_, n) => sender(`old-${n}`, true))].map(
        (row) => ({ kind: 'session' as const, id: row.sessionId, value: row as never }),
      ),
    ],
  })
  const tree = worklistView(pool).tree(requireHere(pool.model('worktree', lane)))
  const stop = autorun(() =>
    insideReader('owner totals', () => {
      if (legacy) {
        // The old helpers consumed row snapshots. Passing today's models here
        // would reuse their cached fields and erase the negative control's work.
        const shown = tree.sessions.map(
          (session) => requireHere(pool.row('session', session.id)) as unknown as SliceSession,
        )
        void sidebarTiming(shown, tree.visiblePhase, false, tree.activityAt)
        void fleetOf(shown)
      } else {
        void tree.timing
        void tree.visibleFleet
      }
      void tree.visibleUnread
      void tree.waitingCount
    }),
  )
  if (hidden) {
    stop()
    await Promise.resolve()
    await Promise.resolve()
  }
  const read = vi.spyOn(pool, 'row')
  try {
    const result = await measureWork(
      async () =>
        insideArm(() =>
          runInAction(() =>
            pool.apply({
              type: 'update',
              rows: [
                {
                  kind: 'session',
                  id: 'a',
                  value: {
                    ...live[0],
                    ...(readState
                      ? { unread: true }
                      : {
                          lastActiveAt: '2026-10-09T07:01:00Z',
                          agentState: { ...live[0]!.agentState, workingMsTotal: 99 },
                        }),
                  } as never,
                },
              ],
            }),
          ),
        ),
      { pool },
    )
    const peers = read.mock.calls.filter(
      ([entity, id]) => entity === 'session' && (id === 'b' || id === 'c'),
    ).length
    const timerBodies = Object.entries(result.work.derivationsBy)
      .filter(([name]) =>
        /WorklistWorktree.*(Timer|Timing|Fleet|workingMsTotal|doneSinceMs)/.test(name),
      )
      .reduce((count, [, value]) => count + value, 0)
    return { work: result.work, peers, timerBodies }
  } finally {
    read.mockRestore()
    if (!hidden) stop()
    pool.dispose()
  }
}

it('remeasures old roster reads and updates only the changed session fact', async () => {
  const old = await measure(32, true),
    next = await measure(32, false)
  expect(old.peers).toBeGreaterThan(0)
  expect(next.peers).toBe(0)
  expect(next.timerBodies).toBeGreaterThan(0)
  console.info('owner raw unchanged-peer reads', { old: old.peers, next: next.peers })
})

for (const readState of [false, true])
  it(`${readState ? 'read state' : 'member heartbeat'} work is flat at 1x and 4x archived owner history`, async () => {
    const one = await measure(32, false, false, readState),
      four = await measure(128, false, false, readState)
    expect(typeof one.work.rows).toBe('number')
    for (const kind of ['rows', 'derivations', 'elements'] as const)
      expect(four.work[kind], kind).toBe(one.work[kind])
    expect({ one: one.peers, four: four.peers }).toEqual({ one: 0, four: 0 })
    const counts = (work: typeof one.work) => ({
      rows: work.rows,
      derivations: work.derivations,
      elements: work.elements,
    })
    console.info(`owner ${readState ? 'read state' : 'heartbeat'} work`, {
      one: counts(one.work),
      four: counts(four.work),
    })
  })

it('a hidden owner row runs no timing or fleet total and reads no peer facts', async () => {
  for (const history of [32, 128])
    for (const readState of [false, true]) {
      const result = await measure(history, false, true, readState)
      expect(result.timerBodies).toBe(0)
      expect(result.peers).toBe(0)
    }
})
