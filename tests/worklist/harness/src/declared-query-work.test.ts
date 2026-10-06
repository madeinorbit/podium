import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createIssueBoardSource } from '@podium/client-graph/issue-board-source'
import { ISSUE_BOARD_SUMMARIES } from '@podium/client-graph/issue-board-schema'
import { issuePages } from '@podium/client-graph/issue-page'
import { ISSUE_PAGE_SUMMARIES } from '@podium/client-graph/issue-page-schema'
import { MobxPool } from '@podium/client-graph/pool'
import { residentIds } from '@podium/client-graph/enumerate'
import * as runtimePool from '@podium/client-graph/runtime-pool'
import { mergePoolSummaries } from '@podium/client-graph/source-registry'
import type { ReaderQuestion } from '@podium/client-graph/shared/reader-questions'
import type { RowRecord } from '@podium/client-graph/shared/source'
import { LOADING, type Loaded } from '@podium/client-graph/worklist/rollup'
import type { SessionView } from '@podium/client-core/session-values'
import { issueIsActionable } from '@podium/client-core/values'
import { autorun, compareStructural, getDependencyTree, untracked } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { poolScreenCellsAt } from './pool-screen-work'
import {
  assertScreenWork,
  SCREEN_ACTIONS,
  screenWorkVerdicts,
  type ScreenWorkCell,
} from './screen-work-ratios'
import { insideArm, insideReader, measureWork, type WorkCounts } from './work-meter'

const now = Date.parse('2026-10-03T12:00:00Z'),
  old = '2020-01-01T00:00:00Z'
function fixture(scale: number) {
  const rows: RowRecord[] = Array.from({ length: 128 * scale }, (_, index) => ({
    kind: 'issue',
    id: `history-${index}`,
    value: {
      id: `history-${index}`,
      title: `History ${index}`,
      seq: index + 1,
      stage: 'done',
      archived: true,
      closedAt: old,
      createdAt: old,
      updatedAt: old,
      labels: [],
      deps: [],
      repoId: 'repo',
      repoPath: '/query',
      audience: 'human',
      priority: 2,
    },
  }))
  rows.push({
    kind: 'issue',
    id: 'root',
    value: {
      id: 'root',
      title: 'Root',
      seq: 999,
      stage: 'planning',
      archived: false,
      updatedAt: new Date(now).toISOString(),
      createdAt: old,
      deps: [],
      labels: [],
      repoId: 'repo',
      repoPath: '/query',
      audience: 'human',
      priority: 2,
    },
  } as RowRecord)
  for (let index = 0; index < 32 * scale + 1; index++) {
    const id = index === 0 ? 'live-seat' : `history-seat-${index}`
    rows.push({
      kind: 'session',
      id,
      value: {
        sessionId: id,
        issueId: 'root',
        cwd: '/query',
        agentKind: 'codex',
        title: id,
        archived: index !== 0,
        status: index === 0 ? 'live' : 'exited',
        lastActiveAt: old,
        stoppedAt: index === 0 ? undefined : old,
        createdAt: old,
      },
    })
  }
  for (let index = 0; index < 128 * scale; index++) {
    const id = `resident-seat-${index}`
    rows.push({
      kind: 'session',
      id,
      value: {
        sessionId: id,
        cwd: '/elsewhere',
        agentKind: 'codex',
        title: id,
        archived: false,
        status: 'live',
        lastActiveAt: old,
        createdAt: old,
      },
    })
  }
  rows.push({
    kind: 'worktree',
    id: '/query',
    value: {
      path: '/query',
      repoId: 'repo',
      repoPath: '/query',
      repoName: 'Query',
      prefix: 'Q',
    },
  })
  const values = new Map(rows.map((row) => [`${row.kind}:${row.id}`, row.value]))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, {
    load: (entity, id) => values.get(`${entity}:${id}`),
    summaries: mergePoolSummaries(ISSUE_PAGE_SUMMARIES, ISSUE_BOARD_SUMMARIES),
    worklist: 'demand',
    schedule: () => () => {},
  })
  pool.apply({ type: 'replace', rows })
  const patch = (kind: 'issue' | 'session', id: string, value: object) => {
    values.set(`${kind}:${id}`, value as RowRecord['value'])
    pool.apply({ type: 'update', rows: [{ kind, id, value: value as RowRecord['value'] }] })
  }
  return { pool, values, patch }
}

type Mechanism = 'summary' | 'count' | 'roster' | 'identity' | 'attention'
async function measured(
  scale: number,
  mechanism: Mechanism,
  plant: 'scan' | 'wrong' | false = false,
) {
  const f = fixture(scale),
    page = issuePages(f.pool),
    board = createIssueBoardSource(f.pool)
  let actual: unknown
  let stop: () => void = () => {}
  const fullRoster = () =>
    [...f.pool.graph.many('issue', 'root', 'missionSessions')]
      .sort(
        (a, b) =>
          f.pool.graph.orderKey('session', a).localeCompare(f.pool.graph.orderKey('session', b)) ||
          a.localeCompare(b),
      )
      .filter((id) => !f.pool.graph.isCollapsed('session', id))
      .map((id) => f.pool.row('session', id, 'summary'))
      .filter((value) => value !== undefined)
  const fullAttention = () => {
    const row = f.pool.row('issue', 'root', 'summary-fields')
    const seats = fullRoster()
    if (row === LOADING || seats.includes(LOADING)) return LOADING
    const asking =
      row &&
      issueIsActionable(
        row as Parameters<typeof issueIsActionable>[0],
        (seats as SessionView[]).filter((seat) => !seat.archived),
      )
    return { ids: asking ? ['root'] : [] }
  }
  try {
    if (mechanism === 'attention' && plant) {
      const original = board.queryIds.bind(board)
      vi.spyOn(board, 'queryIds').mockImplementation((question) => {
        original(question)
        return plant === 'wrong' ? { ids: [] } : fullAttention()
      })
    }
    if (mechanism === 'identity' && plant) {
      const original = f.pool.queries.ids.bind(f.pool.queries)
      vi.spyOn(f.pool.queries, 'ids').mockImplementation((question) => {
        const ids: string[] = []
        // A real rebuild through the maintained answer's public iterator.
        // A custom iterator must not make this walk invisible to the meter.
        for (const id of original(question)) ids.push(id)
        return plant === 'wrong' ? ids.filter((id) => id !== 'history-0') : ids
      })
    }
    if (mechanism === 'summary' && plant) {
      const rebuild = <T>(
        question: ReaderQuestion,
        _name: string,
        read: (id: string) => Loaded<T>,
      ): Loaded<T[]> => {
        const out: T[] = []
        let pending = false
        for (const id of f.pool.queries.ids(question).sort()) {
          const value = read(id)
          if (value === LOADING) pending = true
          else if (value !== undefined)
            out.push(
              plant === 'wrong' ? ({ ...(value as object), title: 'Planted mistake' } as T) : value,
            )
        }
        return pending ? LOADING : out
      }
      vi.spyOn(f.pool.queries, 'project').mockImplementation(rebuild)
    }
    if (mechanism === 'roster' && plant)
      vi.spyOn(board, 'sessions').mockImplementation(() => {
        const rows = fullRoster() as SessionView[]
        return plant === 'wrong'
          ? rows.map((value) => ({ ...value, title: 'Planted mistake' }))
          : rows
      })
    if (mechanism === 'count' && plant) {
      vi.spyOn(f.pool.queries, 'count').mockImplementation((entity) => {
        if (plant === 'wrong') return 0
        // The exact original count correction, planted in the real reader.
        return (
          f.pool.coldIndex().count(entity) +
          residentIds(f.pool, entity).filter((id) => !f.pool.coldIndex().known(entity, id)).length
        )
      })
    }
    if (mechanism !== 'count')
      stop = autorun(() => {
        actual =
          mechanism === 'attention'
            ? board.queryIds({ kind: 'explorer', tab: 'needs' })
            : mechanism === 'identity'
              ? f.pool.queries.ids({ kind: 'pageIssues' })
              : mechanism === 'summary'
                ? page.issues()
                : board.sessions('root')
      })
    const result = await measureWork(
      async () => {
        if (mechanism === 'count')
          insideReader('count', () => {
            actual = f.pool.queries.count('session')
          })
        else
          insideArm(() => {
            const kind = mechanism === 'summary' || mechanism === 'identity' ? 'issue' : 'session'
            const id =
              mechanism === 'identity'
                ? 'new-history'
                : mechanism === 'summary'
                  ? 'history-0'
                  : 'live-seat'
            const row = f.values.get(
              `${kind}:${mechanism === 'identity' ? 'history-0' : id}`,
            ) as object
            f.patch(
              kind,
              id,
              mechanism === 'attention'
                ? { ...row, offer: { createdAt: old } }
                : mechanism === 'identity'
                  ? { ...row, id }
                  : mechanism === 'summary'
                    ? { ...row, description: 'Unrelated body' }
                    : { ...row, title: 'Updated seat' },
            )
          })
      },
      { pool: f.pool },
    )
    const expected =
      mechanism === 'count'
        ? f.pool.coldIndex().count('session')
        : mechanism === 'attention'
          ? fullAttention()
          : mechanism === 'identity'
            ? [
                ...new Set([
                  ...residentIds(f.pool, 'issue'),
                  ...f.pool.coldIndex().readerIds({ kind: 'pageIssues' }),
                ]),
              ]
            : mechanism === 'roster'
              ? fullRoster()
              : f.pool.queries
                  .ids({ kind: 'pageIssues' })
                  .sort()
                  .map((id) => page.summary(id))
    // pageIssues supplies candidate identities, not presentation order. Its only
    // production reader, IssuePage.issues(), projects them in ID order through
    // createQueryResult. Compare every identity (including duplicates) in that
    // order outside the work measurement; the planted iterator still counts.
    const parityExpected = mechanism === 'identity' ? (expected as string[]).toSorted() : expected
    const parityActual = mechanism === 'identity' ? (actual as string[]).toSorted() : actual
    return {
      work: result.work,
      identical: compareStructural(parityExpected, parityActual),
      expected: parityExpected,
      actual: parityActual,
    }
  } finally {
    stop()
    vi.restoreAllMocks()
    board.dispose()
    f.pool.dispose()
  }
}
function cells(work: WorkCounts): ScreenWorkCell[] {
  return SCREEN_ACTIONS.map((action) => ({ action, neighbourhood: ['addressed:row'], work }))
}

describe('pool screens work ratios: declared query incrementality', () => {
  it.each([1, 4])('identity observes only its declared membership at %ix', (scale) => {
    const f = fixture(scale)
    let ids: string[] = []
    const stop = autorun(() => {
      ids = f.pool.queries.ids({ kind: 'pageIssues' })
    })
    const dependencies = () => getDependencyTree(stop).dependencies?.map((value) => value.name)
    try {
      expect(dependencies()).toEqual(['history.{"kind":"pageIssues"}'])
      const before = ids
      f.patch('issue', 'new-history', {
        ...(f.values.get('issue:history-0') as object),
        id: 'new-history',
      })
      expect(ids).toContain('new-history')
      expect(before).not.toContain('new-history')
      expect(dependencies()).toEqual(['history.{"kind":"pageIssues"}'])
    } finally {
      stop()
      f.pool.dispose()
    }
  })

  it.each([
    'summary',
    'count',
    'roster',
    'identity',
    'attention',
  ] as const)('%s stays flat and rejects a real full rebuild with identical output', async (mechanism) => {
    const one = await measured(1, mechanism),
      four = await measured(4, mechanism)
    expect(one.actual).toEqual(one.expected)
    expect(four.actual).toEqual(four.expected)
    expect(one.identical && four.identical).toBe(true)
    assertScreenWork(screenWorkVerdicts(cells(one.work), cells(four.work)))
    const plantedOne = await measured(1, mechanism, 'scan'),
      plantedFour = await measured(4, mechanism, 'scan')
    expect(plantedOne.identical && plantedFour.identical).toBe(true)
    expect(() =>
      assertScreenWork(screenWorkVerdicts(cells(plantedOne.work), cells(plantedFour.work))),
    ).toThrow(/grew with total data/)
    expect((await measured(1, mechanism, 'wrong')).identical).toBe(false)
    console.info(
      `[declared query] ${mechanism}: rows ${one.work.rows}→${four.work.rows}; derivations ${one.work.derivations}→${four.work.derivations}; elements ${one.work.elements}→${four.work.elements}; planted scan rejected`,
    )
  })
})

describe('pool screens work ratios: declared query screen counters', () => {
  it('keeps the original summary, roster and count mechanisms green under the scripted clicks', async () => {
    const only = new Set(['issue-page.detail', 'issue-page.panel', 'issue-page.catalog', 'session-pane', 'board.card'])
    let pool: MobxPool | undefined
    const original = runtimePool.createRuntimeWorklistPool
    const spy = vi.spyOn(runtimePool, 'createRuntimeWorklistPool').mockImplementation((...args) => {
      const handle = original(...args)
      pool = handle.pool
      return handle
    })
    const inputs: unknown[] = []
    const capture = () => {
      if (inputs.length) return
      inputs.push(
        untracked(() =>
          ['guard-root', 'guard-child'].map((id) => {
            const row = pool!.row('issue', id, 'summary-fields')
            const repoId = pool!.graph.one('issue', id, 'repo')
            const repo = repoId ? pool!.row('repo', repoId) : undefined
            if (!row || row === LOADING || repo === LOADING)
              throw new Error('Visible index input is not loaded')
            const value = row as Record<string, unknown>
            return {
              id,
              title: value.title,
              description: value.description,
              seq: value.seq,
              prefix: (repo as { prefix?: string } | undefined)?.prefix,
              repoPath: value.repoPath,
              parentId: value.parentId,
              priority: value.priority,
              audience: value.audience,
              stage: value.stage,
              blocked: value.blocked,
              deferUntil: value.deferUntil,
            }
          }),
        ),
      )
    }
    const at1x = await poolScreenCellsAt(1, capture, only)
    const oneInputs = inputs.pop()
    const at4x = await poolScreenCellsAt(4, capture, only)
    const fourInputs = inputs.pop()
    spy.mockRestore()
    // A fixed number of drawn rows alone is insufficient if their indexed
    // text varies: that is input work, rather than growth with hidden history.
    expect(oneInputs).toEqual(fourInputs)
    const verdicts = screenWorkVerdicts(at1x.cells, at4x.cells)
    const judged = verdicts.filter((value) =>
      /IssuePage@summaries|IssueBoard@sessions:|IssueBoard@index:|^consumer:session-pane(?:\/|$)/.test(
        value.reader,
      ) ||
      (value.reader === 'consumer:issue-page.detail/IssuePage@page:guard-root' && value.action === 'select') ||
      (value.reader === 'consumer:issue-page.detail/IssuePage@page:guard-child' && value.action === 'navigate-by-ref') ||
      ((value.reader === 'consumer:issue-page.detail' || value.reader === 'consumer:issue-page.panel') && value.action === 'navigate-by-ref') ||
      (value.reader === 'consumer:issue-page.detail/IssuePage@issue:guard-root' && value.action === 'machine-flip'),
    )
    // cf4d2a0373 made the board index demand-only: cards do not retain it.
    // POD-5555 removes that index. Any index work still meets the ratios above,
    // but only the mounted summary, roster and pane readers must do work here.
    for (const pattern of [
      /IssuePage@summaries/,
      /IssueBoard@sessions:/,
      /^consumer:session-pane/,
    ])
      expect(
        judged.some((value) => pattern.test(value.reader) && value.at1x > 0),
        `No measured work at 1x for ${pattern}`,
      ).toBe(true)
    const dir = join(import.meta.dirname, '..', 'browser', 'results')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'work-declared-queries.json'),
      JSON.stringify({ at1x, at4x, judged, oneInputs, fourInputs }, null, 2),
    )
    assertScreenWork(judged)
  }, 1_800_000)
})
