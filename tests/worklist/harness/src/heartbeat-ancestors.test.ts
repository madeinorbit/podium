import { sidebarView } from '@podium/client-graph/worklist/sidebar'
/**
 * POD-5423 (review finding 9): one session heartbeat re-derives its own row's
 * attention and moves the activity number up the nest; it never re-runs an
 * ancestor's attention roll-up or copies an ancestor's subtree seats. Counted
 * with the work meter on a nest chain root ← mid ← leaf, the root's subtree
 * also holding K sibling rows with a live seat each (K = 4 and 16): the work
 * is the same at both.
 */
import { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { autorun, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { installMobxWarnTrap } from './mobx-trap'
import { measureWork } from './work-meter'

installMobxWarnTrap()

const NOW = Date.parse('2026-10-03T12:00:00Z')
const LANE = '/synthetic/nest'
const CHAIN = ['nest-root', 'nest-mid', 'nest-leaf'] as const
type Row = Record<string, unknown>

function corpus(siblings: number) {
  const issue = (id: string, seq: number, parentId: string | null): Row => ({
    id,
    seq,
    title: id,
    repoPath: LANE,
    stage: 'in_progress',
    audience: 'human',
    parentId,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-10-03T10:00:00Z',
    readAt: '2026-10-03T11:00:00Z',
    deps: [],
  })
  const seat = (id: string, issueId: string): Row => ({
    sessionId: id,
    cwd: `/elsewhere/${id}`,
    issueId,
    agentKind: 'codex',
    title: id,
    archived: false,
    status: 'live',
    createdAt: '2026-10-01T00:00:00Z',
    lastActiveAt: '2026-10-03T11:00:00Z',
    agentState: { phase: 'working', since: '2026-10-03T10:00:00Z' },
  })
  // The root's subtree grows with `siblings`; every drawn row keeps one own seat.
  const side = Array.from({ length: siblings }, (_, n) => `nest-side-${String(n).padStart(3, '0')}`)
  const issues = [
    ...CHAIN.map((id, at) => issue(id, at + 1, at === 0 ? null : (CHAIN[at - 1] as string))),
    ...side.map((id, at) => issue(id, 100 + at, 'nest-root')),
  ]
  const sessions = [...CHAIN, ...side].map((id) => seat(`${id}-seat`, id))
  return { issues, sessions }
}

async function run(siblings: number) {
  const { issues, sessions } = corpus(siblings)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
  pool.apply({
    type: 'replace',
    rows: [
      ...issues.map((value) => ({
        kind: 'issue' as const,
        id: String(value['id']),
        value: value as never,
      })),
      ...sessions.map((value) => ({
        kind: 'session' as const,
        id: String(value['sessionId']),
        value: value as never,
      })),
    ],
  })
  const drawn = new Map<string, unknown>()
  const stop = autorun(() => {
    for (const id of CHAIN) drawn.set(id, sidebarView(pool).row(id))
  })
  try {
    const before = runInAction(() => CHAIN.map((id) => pool.worklistRow(id)?.nestParent))
    const leaf = sessions.find((row) => row['sessionId'] === 'nest-leaf-seat')!
    const { work } = await measureWork(
      async () =>
        pool.apply({
          type: 'update',
          rows: [
            {
              kind: 'session',
              id: 'nest-leaf-seat',
              value: { ...leaf, lastActiveAt: '2026-10-03T11:59:00Z' } as never,
            },
          ],
        }),
      { pool },
    )
    const ran = (id: string, group: string) => work.derivationsBy[`WorklistIssue@${id}.${group}`] ?? 0
    const walked = (group: string) =>
      CHAIN.reduce((sum, id) => sum + (work.elementsBy[`WorklistIssue@${id}.${group}`] ?? 0), 0)
    const rows = CHAIN.map((id) => drawn.get(id))
    return {
      nest: before,
      attention: CHAIN.map((id) => ran(id, 'attention')),
      activity: CHAIN.map((id) => ran(id, 'activity')),
      walked: {
        attention: walked('attention'),
        sidebar: walked('sidebar'),
        activity: walked('activity'),
      },
      activityAt: rows.map((row) =>
        row === LOADING || row === undefined ? null : (row as { timing: unknown }).timing,
      ),
    }
  } finally {
    stop()
    pool.dispose()
  }
}

describe('a heartbeat under a nest', () => {
  it('re-derives its own row and the activity chain, never the ancestors’ roll-ups', async () => {
    const small = await run(4)
    const large = await run(16)
    console.info('[heartbeat ancestors] K=4', JSON.stringify(small), 'K=16', JSON.stringify(large))
    expect(small.nest).toEqual([null, 'nest-root', 'nest-mid'])
    // Only the leaf's own attention re-runs (its seat's verdict moved).
    expect(small.attention).toEqual([0, 0, 1])
    // The activity number moves up the chain, one composition per level.
    expect(small.activity).toEqual([1, 1, 1])
    // Before POD-5423 every ancestor re-ran attention, copying its subtree's
    // seat rows, and the count grew with K.
    expect(large.attention).toEqual(small.attention)
    expect(large.activity).toEqual(small.activity)
    expect(large.walked.attention).toBe(small.walked.attention)
    expect(large.walked.sidebar).toBe(small.walked.sidebar)
    // The activity number is a max over each level's nest children: the root
    // reads its K drawn child rows' numbers, never a seat row or array.
    expect(large.walked.activity - small.walked.activity).toBeLessThanOrEqual(3 * (16 - 4))
  }, 120_000)
})
