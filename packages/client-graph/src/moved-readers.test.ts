/**
 * POD-7088 acceptance 2: every reader moved off "all the rows in memory"
 * answers what it answered before, on the same fixture, and the comparison
 * fails when the new answer is wrong.
 *
 * OLD: a pool fed every row, with no device store (no loader): the readers
 * read the rows in memory, which was all history.
 * NEW: the same rows, with a device store whose stubs hold every issue and
 * whose markers say the stubs are complete: the moved readers read stubs and
 * markers. A partial device (the sidebar issues only, stubs complete) must
 * answer the same; a device whose stubs are not complete answers LOADING; a
 * planted wrong stub must show up as a different answer.
 */

import { runInAction } from 'mobx'
import { afterEach, describe, expect, it } from 'vitest'
import { fullDevice } from './full-device-fixture'
import { createIssueBoardSource } from './issue-board-source'
import { LOADING } from './loading'
import { childProgressOf } from './lookup'
import { screeningQueue, screeningTotal } from './mobile-triage'
import { MobxPool } from './pool'
import { settingsHasFirstTask } from './settings-views'
import type { CollectionLoaderPort, LoaderInstance, RowRecord } from './shared/source'

const STAMP = '2026-10-01T12:00:00Z'
const STUB = [
  'id',
  'repoId',
  'seq',
  'stage',
  'closedReason',
  'archived',
  'deletedAt',
  'isDraftVessel',
  'audience',
  'parentId',
] as const

type Issue = Record<string, unknown> & { id: string }
const issue = (id: string, fields: Partial<Issue> = {}): Issue => ({
  id,
  title: id,
  seq: 1,
  repoId: 'repo-a',
  repoPath: '/work/a',
  stage: 'backlog',
  priority: 2,
  archived: false,
  deletedAt: null,
  parentId: null,
  deps: [],
  labels: [],
  audience: 'human',
  createdAt: STAMP,
  updatedAt: STAMP,
  readAt: STAMP,
  ...fields,
})
/** A tree with closed history under an open root, agent and draft work, and a proposal deck. */
const ISSUES: Issue[] = [
  issue('root', { seq: 1, stage: 'in_progress' }),
  issue('open-child', { seq: 2, parentId: 'root', stage: 'backlog' }),
  issue('done-child', { seq: 3, parentId: 'root', stage: 'done', closedReason: 'done' }),
  issue('cancelled-child', { seq: 4, parentId: 'root', stage: 'done', closedReason: 'cancelled' }),
  issue('archived-child', {
    seq: 5,
    parentId: 'root',
    stage: 'done',
    closedReason: 'done',
    archived: true,
  }),
  issue('deleted', { seq: 6, stage: 'backlog', deletedAt: STAMP }),
  issue('agent-task', { seq: 7, stage: 'backlog', audience: 'agent' }),
  issue('draft', { seq: 8, stage: 'backlog', isDraftVessel: true }),
  issue('proposal-1', { seq: 9, stage: 'proposed', priority: 1 }),
  issue('proposal-2', { seq: 10, stage: 'proposed' }),
  issue('proposal-child', { seq: 11, stage: 'proposed', parentId: 'proposal-1' }),
  issue('other-repo', {
    seq: 1,
    repoId: 'repo-b',
    repoPath: '/work/b',
    stage: 'done',
    closedReason: 'done',
  }),
]
const REPOS = [
  { id: 'repo-a', prefix: 'AAA', repoPath: '/work/a' },
  { id: 'repo-b', prefix: 'BBB', repoPath: '/work/b' },
]
const SIDEBAR = new Set(['root', 'open-child', 'agent-task', 'draft'])

function rows(issues: readonly Issue[]): RowRecord[] {
  return [
    ...REPOS.map((value) => ({ kind: 'repo' as const, id: value.id, value: value as never })),
    ...issues.map((value) => ({ kind: 'issue' as const, id: value.id, value: value as never })),
  ]
}

/** A device store over `stubs`, holding the named collections complete. */
function port(stubs: readonly Issue[], complete: ReadonlySet<string>): CollectionLoaderPort {
  const table = new Map(
    stubs.map((value) => [
      value.id,
      Object.fromEntries(
        STUB.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]),
      ),
    ]),
  )
  const byParent = new Map<string, string[]>()
  for (const value of stubs)
    if (typeof value.parentId === 'string')
      byParent.set(value.parentId, [...(byParent.get(value.parentId) ?? []), value.id])
  const stubRows = [...table].map(([id, stub]) => ({ id, stub }))
  const done = (spec: LoaderInstance) => complete.has(spec.collection) && spec.args === undefined
  return {
    request: () => {},
    show: () => () => {},
    status: (spec) => (done(spec) ? 'complete' : 'loading'),
    online: true,
    firstDownload: false,
    isComplete: (spec) => (done(spec) ? {} : undefined),
    wasRefused: () => false,
    stubOf: (_entity, id) => table.get(id),
    stubsByParent: (id) => byParent.get(id) ?? [],
    stubRows: () => stubRows,
    subscribe: () => () => {},
  }
}

const pools: MobxPool[] = []
afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose()
})
function pool(issues: readonly Issue[], device?: CollectionLoaderPort): MobxPool {
  const made = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(STAMP) })
  if (device) made.collections.attach(() => device)
  else fullDevice(made)
  runInAction(() => made.apply({ type: 'replace', rows: rows(issues) }))
  pools.push(made)
  return made
}

const STUBS_DONE = new Set(['issueProjection.stubs'])
const COLUMN = { filter: {}, ordering: 'updated' as const, showAgentTasks: false }

/** Every moved reader's answer, as the screens read it. */
function answers(p: MobxPool) {
  const board = createIssueBoardSource(p)
  try {
    return {
      childCounts: Object.fromEntries(
        ['root', 'proposal-1', 'open-child'].map((id) => [id, p.queries.issueChildCounts(id)]),
      ),
      modelProgress: childProgressOf(p.issueObject('root')),
      undeleted: p.undeletedIssueCount,
      hasFirstTask: settingsHasFirstTask(p),
      screening: screeningTotal(p),
      columns: Object.fromEntries(
        (['proposed', 'backlog', 'in_progress', 'done'] as const).map((stage) => [
          stage,
          board.columnCount({ ...COLUMN, stage }),
        ]),
      ),
      agentColumns: board.columnCount({ ...COLUMN, showAgentTasks: true, stage: 'backlog' }),
      projectColumn: board.columnCount({
        ...COLUMN,
        filter: { projectPaths: ['/work/b'] },
        stage: 'done',
      }),
      scope: Object.fromEntries(
        ['agent-task', 'draft', 'deleted'].map((id) => [id, p.queries.issueScope(id)]),
      ),
      reference: p.queries.linkedIssueId('BBB-1'),
      prefixLive: p.queries.hasIssuePrefix('BBB'),
    }
  } finally {
    ;(board as { dispose?: () => void }).dispose?.()
  }
}

describe('moved readers answer as before (POD-7088)', () => {
  it('old (all rows in memory) and new (stubs) agree on the same fixture', () => {
    const full = pool(ISSUES)
    const old = answers(full)
    const fresh = answers(pool(ISSUES, port(ISSUES, STUBS_DONE)))
    // The old screening count was the deck the pool held whole.
    const deck = screeningQueue(full)
    expect(old.screening).toBe(LOADING)
    expect(fresh.screening).toBe(deck === LOADING ? deck : deck?.length)
    expect({ ...fresh, screening: undefined }).toEqual({ ...old, screening: undefined })
    // Every child counts, archived ones too; only the done stage completes.
    expect(old.childCounts.root).toEqual({ childCount: 4, childDoneCount: 3 })
    expect(old.columns).toEqual({ proposed: 2, backlog: 0, in_progress: 1, done: 1 })
  })

  it('a device that holds only the sidebar answers the same from its stubs', () => {
    const old = answers(pool(ISSUES))
    const partial = answers(
      pool(
        ISSUES.filter((row) => SIDEBAR.has(row.id)),
        port(ISSUES, STUBS_DONE),
      ),
    )
    expect(partial.childCounts).toEqual(old.childCounts)
    expect(partial.modelProgress).toEqual(old.modelProgress)
    expect(partial.undeleted).toEqual(old.undeleted)
    expect(partial.columns.proposed).toEqual(old.columns.proposed)
    expect(partial.columns.done).toEqual(old.columns.done)
    expect(partial.projectColumn).toEqual(old.projectColumn)
    expect(partial.scope).toEqual(old.scope)
    expect(partial.reference).toEqual(old.reference)
    expect(partial.prefixLive).toEqual(old.prefixLive)
    expect(partial.screening).toBe(2)
  })

  it('answers LOADING, never a smaller number, while the stubs are not complete', () => {
    const partial = answers(
      pool(
        ISSUES.filter((row) => SIDEBAR.has(row.id)),
        port(
          ISSUES.filter((row) => SIDEBAR.has(row.id)),
          new Set(),
        ),
      ),
    )
    expect(partial.childCounts.root).toBe(LOADING)
    expect(partial.modelProgress).toBeUndefined()
    expect(partial.undeleted).toBe(LOADING)
    expect(partial.screening).toBe(LOADING)
    expect(partial.columns.done).toBe(LOADING)
    expect(partial.columns.proposed).toBe(LOADING)
    // The device holds an undeleted issue: there is a first task.
    expect(partial.hasFirstTask).toBe(true)
  })

  it('is armed: a wrong stub gives a different answer', () => {
    const old = answers(pool(ISSUES))
    const planted = ISSUES.map((row) =>
      row.id === 'cancelled-child'
        ? { ...row, stage: 'backlog', closedReason: null, parentId: null }
        : row.id === 'other-repo'
          ? { ...row, seq: 2 }
          : row,
    )
    const wrong = answers(
      pool(
        ISSUES.filter((row) => SIDEBAR.has(row.id)),
        port(planted, STUBS_DONE),
      ),
    )
    expect(wrong.childCounts.root).not.toEqual(old.childCounts.root)
    expect(wrong.columns.backlog).not.toEqual(old.columns.backlog)
    expect(wrong.reference).not.toEqual(old.reference)
  })
})
