import type { SessionView } from '@podium/client-core/session-values'
import { presenceNote, issueDisplayTitle } from '@podium/client-core/values'
import { autorun, observable, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { issuePages, type PageIssue } from './issue-page'
import { MobxPool } from './pool'
import { lazyKeptCount } from '@podium/mobx-helpers'
import { createPoolProjection } from './runtime-pool'
import type { RowRecord } from './shared/source'
import { LOADING, type Loaded } from './worklist/rollup'

const old = '2020-01-01T00:00:00Z'
const issue = (id: string, patch: object = {}): RowRecord =>
  ({
    kind: 'issue',
    id,
    value: {
      id,
      seq: id === 'tip' ? 3 : 1,
      title: id,
      repoId: 'repo',
      repoPath: '/repo',
      stage: 'done',
      createdAt: old,
      updatedAt: old,
      description: '',
      deps: [],
      labels: [],
      deletedAt: null,
      archived: false,
      readAt: null,
      ...patch,
    },
  }) as RowRecord
const seat = (id: string, patch: object = {}): RowRecord =>
  ({
    kind: 'session',
    id,
    value: {
      sessionId: id,
      issueId: 'root',
      refIssueId: 'root',
      cwd: '/repo',
      title: id,
      agentKind: 'codex',
      status: 'exited',
      archived: true,
      lastActiveAt: old,
      ...patch,
    },
  }) as RowRecord

/** Fixed drawn neighbourhood. The equal-output catalog negative control must
 * still trip the meter even when the returned display facts never change. */
it('rejects hidden neighbour history and planted catalogs on open and heartbeat', async () => {
  async function capture(scale: 1 | 4, planted = false) {
    const pool = new MobxPool({ selectedIssueId: 'child', coarseNow: Date.parse(old) })
    pool.apply({
      type: 'replace',
      rows: [
        issue('root', { stage: 'planning' }),
        issue('child', { parentId: 'root', stage: 'planning' }),
        seat('shown', {
          issueId: 'child',
          refIssueId: 'child',
          archived: false,
          status: 'running',
        }),
        ...Array.from({ length: 32 * scale }, (_, n) => seat(`hidden-${n}`)),
        ...Array.from({ length: 128 * scale }, (_, n) => issue(`outside-${n}`)),
      ],
    })
    const views = issuePages(pool)
    let displayed: unknown,
      stop = () => {}
    const read = () => {
      if (planted) views.issues()
      const model = views.issue('child'),
        page = views.row('child')
      if (
        !model ||
        model === LOADING ||
        page.children === LOADING ||
        page.activeSessions === LOADING
      )
        throw new Error('Detail fixture is not loaded')
      const parent = model.parentId ? (pool.issueObject(model.parentId) as PageIssue) : undefined
      displayed = {
        title: page.title,
        description: model.description,
        parent: parent?.authoredTitle,
        children: page.children?.map((child) => child.id),
        members: page.activeSessions?.map((member) => ({
          id: member.sessionId,
          at: member.lastActiveAt,
        })),
      }
    }
    try {
      const open = await measureWork(
        async () =>
          insideReader('detail guard open', () => {
            stop = autorun(read)
          }),
        { pool },
      )
      const heartbeat = await measureWork(
        async () =>
          insideReader('detail guard heartbeat', () => {
            pool.apply({
              type: 'update',
              rows: [
                seat('shown', {
                  issueId: 'child',
                  refIssueId: 'child',
                  archived: false,
                  status: 'running',
                  lastActiveAt: '2026-10-08T08:00:00Z',
                }),
              ],
            })
          }),
        { pool },
      )
      return { displayed, open: open.work, heartbeat: heartbeat.work }
    } finally {
      stop()
      views.dispose()
      pool.dispose()
    }
  }
  const one = await capture(1),
    four = await capture(4)
  expect(one.displayed).toEqual(four.displayed)
  expect(one.open.rows).toBeGreaterThan(0)
  expect(one.heartbeat.rows).toBeGreaterThan(0)
  for (const action of ['open', 'heartbeat'] as const)
    for (const counter of ['rows', 'derivations', 'elements'] as const)
      expect(four[action][counter], `${action}: ${counter}`).toBeLessThanOrEqual(
        one[action][counter],
      )
  const plantedOne = await capture(1, true),
    plantedFour = await capture(4, true)
  expect(plantedOne.displayed).toEqual(plantedFour.displayed)
  expect(plantedFour.open.elements).toBeGreaterThan(plantedOne.open.elements)
  console.info('issue detail archive guard', JSON.stringify({ one, four, catalogRejected: true }))
})

it('keeps identities, raw members and continuation witnesses live without neighbour rosters', () => {
  const root = issue('root'),
    hop = issue('hop', { deps: [{ id: 'root', type: 'discovered-from' }] }),
    tip = issue('tip', { stage: 'planning', deps: [{ id: 'hop', type: 'discovered-from' }] })
  const history = Array.from({ length: 48 }, (_, n) =>
    seat(`history-${String(n).padStart(3, '0')}`),
  )
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(old) })
  pool.sources.register(['issueExit'], { read: () => ({ kind: undefined }), dispose() {} })
  pool.apply({
    type: 'replace',
    rows: [
      root,
      hop,
      tip,
      issue('outside'),
      ...history,
      {
        kind: 'worktree',
        id: '/repo',
        value: { path: '/repo', repoId: 'repo', prefix: 'P', projectRoot: true },
      } as RowRecord,
      seat('tip-agent', { issueId: 'tip', archived: false, status: 'running' }),
      seat('born-away', { issueId: 'outside' }),
      seat('shell', { agentKind: 'shell', archived: false }),
    ],
  })
  const views = issuePages(pool),
    page = views.row('root'),
    model = pool.issueObject('root') as PageIssue
  let presence: unknown, members: Loaded<import('./models').SessionModel[]>, summary: unknown
  const stop = autorun(() => {
    presence = page.presence
    members = page.memberSessions
    summary = model.memberSummary
  })
  const ids = () => (members === LOADING ? LOADING : members?.map((row) => row.sessionId))
  try {
    expect(views.issue('root')).toBe(model)
    expect(page.issue).toBe(model)
    expect(presence).toMatchObject({ text: 'Work continued in P-3' })
    expect(ids()).toEqual(history.map((row) => row.id))
    expect(summary).toEqual({ total: 48, byPhase: { unknown: 48 } })
    const first = members
    pool.apply({ type: 'update', rows: [seat('history-000', { title: 'Renamed' })] })
    expect(members).toBe(first)
    expect(members !== LOADING && members?.[0]?.title).toBe('Renamed')
    pool.apply({
      type: 'update',
      rows: [
        seat('history-000', {
          archived: false,
          status: 'running',
          agentState: { phase: 'working' },
        }),
      ],
    })
    expect(presence).toBeNull()
    expect(summary).toEqual({ total: 48, byPhase: { working: 1, unknown: 47 } })
    pool.apply({ type: 'update', rows: [seat('history-000', { issueId: 'tip' })] })
    expect(ids()).toEqual(history.slice(1).map((row) => row.id))
    expect(presence).toMatchObject({ text: 'Work continued in P-3' })
    pool.apply({ type: 'update', rows: [issue('hop', { ...hop.value, archived: true })] })
    expect(presence).toMatchObject({ kind: 'done' })
    pool.apply({ type: 'update', rows: [hop] })
    expect(presence).toMatchObject({ kind: 'moved' })
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'history-001', value: undefined }] })
    expect(ids()).toHaveLength(46)
    pool.apply({ type: 'replace', rows: [root, history[0]!] })
    expect(ids()).toEqual(['history-000'])
    expect(views.issue('root')).toBe(model)
    stop()
    views.dispose()
    expect(views.issue('root')).toBe(LOADING)
  } finally {
    stop()
    views.dispose()
    pool.dispose()
  }
})

it('isolates scalar, body, child and roster observers and releases watched fields', async () => {
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(old) })
  const root = issue('root', { stage: 'planning' }),
    child = issue('child', { parentId: 'root' })
  pool.apply({
    type: 'replace',
    rows: [root, child, seat('shown', { archived: false, status: 'running' })],
  })
  const views = issuePages(pool),
    model = pool.issueObject('root') as PageIssue
  const scalar = vi.fn(),
    body = vi.fn(),
    children = vi.fn(),
    roster = vi.fn()
  const stops = [
    autorun(() => scalar(model.authoredTitle)),
    autorun(() => body(model.description)),
    autorun(() => children(views.row('root').children)),
    autorun(() => roster(views.row('root').activeSessions)),
  ]
  try {
    const firstList = children.mock.calls.at(-1)?.[0]
    pool.apply({
      type: 'update',
      rows: [issue('root', { ...root.value, description: { value: 'New body' } })],
    })
    expect(scalar).toHaveBeenCalledTimes(1)
    expect(body).toHaveBeenCalledTimes(2)
    expect(children).toHaveBeenCalledTimes(1)
    pool.apply({ type: 'update', rows: [issue('child', { ...child.value, title: 'New child' })] })
    expect(children).toHaveBeenCalledTimes(1)
    expect(firstList[0].authoredTitle).toBe('New child')
    pool.apply({
      type: 'update',
      rows: [seat('shown', { archived: false, status: 'running', name: 'Renamed' })],
    })
    expect(roster).toHaveBeenCalledTimes(1)
    for (const stop of stops) stop()
    await Promise.resolve()
    expect(lazyKeptCount(model)).toBe(0)
    pool.apply({
      type: 'update',
      rows: [issue('root', { ...root.value, description: 'After close' })],
    })
    expect(body).toHaveBeenCalledTimes(2)
  } finally {
    for (const stop of stops) stop()
    views.dispose()
    pool.dispose()
  }
})

it('keeps named and draft detail independent of unrelated worktree choices at 1x/4x', async () => {
  async function measured(scale: 1 | 4, draft: boolean) {
    const lane = (path: string, patch: object = {}): RowRecord =>
      ({ kind: 'worktree', id: path, value: { path, projectRoot: false, ...patch } }) as RowRecord
    const root = issue('root', {
      stage: 'planning',
      title: draft ? 'Draft' : 'Named issue',
      isDraftVessel: draft,
      worktreePath: '/repo/owned',
    })
    const shown = seat('shown', {
      archived: false,
      status: 'running',
      name: ' Chosen agent ',
      cwd: '/repo/owned',
    })
    const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(old) })
    pool.apply({
      type: 'replace',
      rows: [
        root,
        shown,
        seat('0-shell', { archived: false, agentKind: 'shell', name: 'Wrong shell' }),
        seat('0-archived', { name: 'Wrong history' }),
        lane('/repo/owned'),
        lane('/repo/owned/nested'),
        seat('0-nested', {
          issueId: undefined,
          archived: false,
          cwd: '/repo/owned/nested',
          name: 'Wrong checkout',
        }),
        ...Array.from({ length: 128 * scale }, (_, n) => lane(`/elsewhere/${n}`)),
        ...Array.from({ length: 128 * scale }, (_, n) =>
          seat(`foreign-${n}`, {
            issueId: 'outside',
            refIssueId: 'outside',
            cwd: `/elsewhere/${n}`,
          }),
        ),
      ],
    })
    const views = issuePages(pool),
      reads = vi.spyOn(pool, 'row'),
      keys = vi.spyOn(pool.tables.worktree, 'keys'),
      paint = vi.fn()
    const projection = createPoolProjection(pool, () => views.row('root').title)
    let stop = () => {}
    const measure = (name: string, action: () => void) =>
      measureWork(async () => insideReader(name, action), { pool })
    try {
      const first = await measure('detail first title', () => {
        projection.getSnapshot()
        stop = projection.subscribe(paint)
      })
      expect(projection.getSnapshot()).toBe(draft ? 'Chosen agent' : 'Named issue')
      expect(reads.mock.calls.filter(([kind]) => kind === 'worktree')).toEqual([])
      expect(keys).not.toHaveBeenCalled()
      const repeat = await measure('detail repeated title', () => {
        projection.getSnapshot()
      })
      const unrelated = await measure('detail unrelated lane', () =>
        pool.apply({ type: 'update', rows: [lane('/elsewhere/0', { branch: 'changed' })] }),
      )
      expect(paint).not.toHaveBeenCalled()
      const changed = await measure('detail named seat', () =>
        pool.apply({ type: 'update', rows: [seat('shown', { ...shown.value, name: 'New name' })] }),
      )
      expect(projection.getSnapshot()).toBe(draft ? 'New name' : 'Named issue')
      stop()
      paint.mockClear()
      const closed = await measure('detail closed lane', () =>
        pool.apply({ type: 'update', rows: [lane('/elsewhere/0', { branch: 'closed' })] }),
      )
      expect(paint).not.toHaveBeenCalled()
      return {
        first: first.work,
        repeat: repeat.work,
        unrelated: unrelated.work,
        changed: changed.work,
        closed: closed.work,
      }
    } finally {
      stop()
      views.dispose()
      pool.dispose()
      vi.restoreAllMocks()
    }
  }
  for (const draft of [false, true]) {
    const first = await measured(1, draft),
      second = await measured(4, draft)
    console.info('issue detail worktree work1x4x', JSON.stringify({ draft, first, second }))
    for (const action of Object.keys(first) as (keyof typeof first)[])
      for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
        expect(second[action][counter]).toBe(first[action][counter])
  }
})

it('keeps document, relation, readiness, close and exit questions live on the shared issue', () => {
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(old) })
  const exits = observable.map<string, 'evicted' | 'removed'>()
  pool.sources.register(['issueExit'], {
    read: (_entity, id) => ({ kind: exits.get(id) }),
    dispose() {},
  })
  const root = issue('root', {
    stage: 'planning',
    description: { value: 'Body' },
    notes: { value: 'Notes' },
    needsHuman: true,
    asked: { question: 'Ready?' },
    parentBranch: 'trunk',
    gitState: { dirtyOwn: 2, dirtyFiles: 8, ahead: 3, shared: false, merged: false },
  })
  pool.apply({
    type: 'replace',
    rows: [
      root,
      issue('source', {
        deps: [
          { id: 'root', type: 'blocks' },
          { id: 'root', type: 'custom' },
        ],
      }),
    ],
  })
  const model = pool.issueObject('root') as PageIssue,
    views = issuePages(pool)
  let answers: unknown
  const stop = autorun(() => {
    answers = {
      description: model.description,
      notes: model.notes,
      ready: model.ready,
      deferred: model.deferred,
      relations: model.relationGroups,
      close: views.closeFacts('root'),
      exit: model.exitKind,
    }
  })
  try {
    expect(answers).toMatchObject({
      description: 'Body',
      notes: 'Notes',
      ready: true,
      deferred: false,
      close: {
        subject: {
          needsHuman: true,
          asked: { question: 'Ready?' },
          parentBranch: 'trunk',
          git: { dirty: 2, delivery: 3, shared: false, merged: false },
        },
        members: { offers: 0, working: 0 },
      },
    })
    expect(model.dependents).toEqual([
      { id: 'source', type: 'blocks' },
      { id: 'source', type: 'custom' },
    ])
    pool.apply({
      type: 'update',
      rows: [
        issue('root', {
          ...root.value,
          stage: 'done',
          description: 'Edited',
          notes: undefined,
          needsHuman: false,
          asked: undefined,
          gitState: { shared: true, dirtyFiles: 7, commits: [{ sha: 'a' }], merged: true },
        }),
      ],
    })
    expect(answers).toMatchObject({
      description: 'Edited',
      notes: undefined,
      ready: false,
      close: {
        subject: {
          needsHuman: false,
          asked: undefined,
          git: { dirty: 0, delivery: 1, shared: true, merged: true },
        },
      },
    })
    runInAction(() => exits.set('root', 'evicted'))
    expect(answers).toMatchObject({ exit: 'evicted' })
    runInAction(() => exits.set('root', 'removed'))
    expect(answers).toMatchObject({ exit: 'removed' })
    pool.apply({ type: 'update', rows: [issue('source', { deps: [] })] })
    expect(model.relationGroups).toEqual([])
  } finally {
    stop()
    views.dispose()
    pool.dispose()
  }
})
