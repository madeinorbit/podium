import { sidebarView } from '@podium/client-graph/worklist/sidebar'
/**
 * POD-5423 (review finding 8): an issue's members group never walks the
 * issue's session history on a click or a single-row change. A heartbeat (the
 * seat's row and the issue's joined session facts), a mark-read of one seat
 * and a stage move each cost the same at 1x and 4x history, and every answer
 * equals the plain rebuild's (every seat judged directly), including across
 * a decay deadline, a read that revives a finished seat, and a seat joining.
 */
import { MobxPool } from '@podium/client-graph/pool'
import { directVisibility } from '@podium/client-graph/worklist/visible'
import { autorun, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { installMobxWarnTrap } from './mobx-trap'
import { measureWork } from './work-meter'

installMobxWarnTrap()

const NOW = Date.parse('2026-10-03T12:00:00Z')
const LANE = '/synthetic/lane'
const ROOT = 'member-root'
const SEAT = 'member-seat'
const RECENT = 'member-recent'
const HOUR = 60 * 60 * 1000

type Row = Record<string, unknown>

function build(scale: number) {
  const root: Row = {
    id: ROOT,
    seq: 7,
    title: ROOT,
    repoPath: LANE,
    worktreePath: LANE,
    stage: 'in_progress',
    audience: 'human',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-10-03T10:00:00Z',
    readAt: '2026-10-03T11:00:00Z',
    deps: [],
  }
  const session = (id: string, extra: Row): Row => ({
    sessionId: id,
    cwd: LANE,
    issueId: ROOT,
    agentKind: 'codex',
    title: id,
    archived: false,
    status: 'exited',
    createdAt: '2026-01-01T00:00:00Z',
    lastActiveAt: '2026-01-01T00:00:00Z',
    stoppedAt: '2026-01-01T00:00:00Z',
    readAt: '2026-01-02T00:00:00Z',
    ...extra,
  })
  const history = Array.from({ length: 32 * scale }, (_, n) =>
    session(`member-history-${String(n).padStart(4, '0')}`, {}),
  )
  const seat = session(SEAT, {
    status: 'live',
    stoppedAt: undefined,
    readAt: undefined,
    lastActiveAt: '2026-10-03T11:59:00Z',
    agentState: { phase: 'working', since: '2026-10-03T11:00:00Z' },
  })
  // Finished two hours ago, read at once: retained for its grace window only.
  const recent = session(RECENT, {
    lastActiveAt: new Date(NOW - 2 * HOUR).toISOString(),
    stoppedAt: new Date(NOW - 2 * HOUR).toISOString(),
    readAt: new Date(NOW - 2 * HOUR).toISOString(),
  })
  return { root, history, seat, recent }
}

/** The members answers, live, and from the plain rebuild (every seat judged directly). */
function answers(pool: MobxPool) {
  return runInAction(() => {
    const issue = pool.worklistRow(ROOT)!
    const live = {
      retainedSeatIds: issue.retainedSeatIds,
      rosterIds: issue.rosterIds,
      retained: issue.retained,
      liveRoster: issue.liveRoster,
      openOwn: issue.openOwn,
      unread: issue.issue.unread,
    }
    const plain = directVisibility(
      { ...pool.visibleInputs, seatSummary: undefined },
      ROOT,
      new Map(),
    )
    const direct = {
      retainedSeatIds: plain.retainedSeatIds,
      rosterIds: plain.rosterIds,
      retained: plain.retained,
      liveRoster: plain.liveRoster,
      openOwn: plain.openOwn,
      unread: plain.unread,
    }
    return { live, direct }
  })
}

async function run(scale: number) {
  const { root, history, seat, recent } = build(scale)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
  const publish = (rows: { kind: 'issue' | 'session'; value: Row }[]) =>
    pool.apply({
      type: 'update',
      rows: rows.map(({ kind, value }) => ({
        kind,
        id: String(kind === 'issue' ? value['id'] : value['sessionId']),
        value: value as never,
      })),
    })
  pool.apply({
    type: 'replace',
    rows: [
      {
        kind: 'worktree',
        id: LANE,
        value: { path: LANE, repoPath: LANE, repoName: 'Synthetic', projectIndex: 0 } as never,
      },
      { kind: 'issue', id: ROOT, value: root as never },
      ...[...history, seat, recent].map((value) => ({
        kind: 'session' as const,
        id: String(value['sessionId']),
        value: value as never,
      })),
    ],
  })
  const parity: ReturnType<typeof answers>[] = []
  // What a drawn row and the filing read of the issue.
  const stop = autorun(() => {
    const issue = pool.worklistRow(ROOT)!
    void [
      issue.retainedSeatIds,
      issue.rosterIds,
      issue.openOwn,
      issue.placed,
      sidebarView(pool).row(ROOT),
    ]
  })
  try {
    parity.push(answers(pool))
    const work: Record<string, { members: number; derivations: number }> = {}
    const step = async (name: string, change: () => void) => {
      const { work: counted } = await measureWork(async () => change(), { pool })
      work[name] = {
        members: counted.elementsBy[`IssueModel@${ROOT}.members`] ?? 0,
        derivations: counted.derivationsBy[`IssueModel@${ROOT}.members`] ?? 0,
      }
      parity.push(answers(pool))
    }
    let stamp = NOW
    await step('heartbeat', () => {
      stamp += 1000
      const at = new Date(stamp).toISOString()
      publish([
        { kind: 'session', value: { ...seat, lastActiveAt: at } },
      ])
    })
    await step('mark-read', () =>
      publish([{ kind: 'session', value: { ...seat, readAt: new Date(stamp).toISOString() } }]),
    )
    await step('stage-change', () =>
      publish([{ kind: 'issue', value: { ...root, stage: 'review' } }]),
    )
    // Correctness beyond the counted steps: a decay deadline, a revival, a join.
    runInAction(() =>
      pool.clock.advance(NOW + 30 * 24 * HOUR),
    )
    parity.push(answers(pool))
    publish([
      {
        kind: 'session',
        value: { ...history[0]!, readAt: new Date(NOW + 30 * 24 * HOUR).toISOString() },
      },
    ])
    parity.push(answers(pool))
    publish([{ kind: 'session', value: { ...seat, sessionId: 'member-joined', status: 'live' } }])
    parity.push(answers(pool))
    return { work, parity }
  } finally {
    stop()
    pool.dispose()
  }
}

describe('members over session history', () => {
  it('judges one seat per change, the same at 1x and 4x, with the rebuild’s answers', async () => {
    const at1x = await run(1)
    const at4x = await run(4)
    for (const { parity } of [at1x, at4x])
      for (const { live, direct } of parity) expect(live).toEqual(direct)
    // The answers move where the rule says they do.
    const [first, , , , decayed, revived, joined] = at1x.parity
    expect(first!.live.retainedSeatIds).toEqual([RECENT, SEAT])
    expect(decayed!.live.retainedSeatIds).toEqual([SEAT])
    expect(revived!.live.retainedSeatIds).toEqual(['member-history-0000', SEAT])
    expect(joined!.live.rosterIds).toEqual(['member-joined', SEAT])
    console.info('[member history] 1x', JSON.stringify(at1x.work), '4x', JSON.stringify(at4x.work))
    // Before POD-5423: members walked every seat, 34 → 130 elements per step.
    // Now a step costs the same at 4x history as at 1x, at most one re-run.
    expect(at4x.work).toEqual(at1x.work)
    for (const counts of Object.values(at1x.work)) expect(counts.derivations).toBeLessThanOrEqual(1)
  }, 120_000)
})
