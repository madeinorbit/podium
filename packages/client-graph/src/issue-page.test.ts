import type { SessionView } from '@podium/client-core/session-values'
import { presenceNote } from '@podium/client-core/values'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { createIssuePageViews, type IssuePageData } from './issue-page'
import { MobxPool } from './pool'
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

it('preserves detail catalogs, continuations and roster lifecycle without reading worktree choices', () => {
  const root = issue('root'),
    hop = issue('hop', { deps: [{ id: 'root', type: 'discovered-from' }] }),
    tip = issue('tip', { stage: 'planning', deps: [{ id: 'hop', type: 'discovered-from' }] })
  const history = Array.from({ length: 48 }, (_, n) =>
    seat(`history-${String(n).padStart(3, '0')}`),
  )
  const worktrees = Array.from(
    { length: 64 },
    (_, n) =>
      ({
        kind: 'worktree',
        id: `/repo/w${n}`,
        value: {
          path: `/repo/w${n}`,
          projectRoot: false,
        },
      }) as RowRecord,
  )
  const rows = [
    root,
    hop,
    tip,
    issue('outside', { stage: 'planning' }),
    ...history,
    ...worktrees,
    {
      kind: 'worktree',
      id: '/repo',
      value: {
        path: '/repo',
        repoId: 'repo',
        repoPath: '/repo',
        repoName: 'Repo',
        prefix: 'P',
        projectRoot: true,
      },
    } as RowRecord,
    seat('tip-agent', { issueId: 'tip', archived: false, status: 'running' }),
    seat('born-away', { issueId: 'outside' }),
    seat('born-shell', { issueId: undefined, agentKind: 'shell', archived: false }),
  ]
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(old) })
  pool.sources.register(['issueExit'], { read: () => ({ kind: undefined }), dispose() {} })
  pool.apply({ type: 'replace', rows })
  const views = createIssuePageViews(pool)
  let current: Loaded<IssuePageData> = LOADING
  const stop = autorun(() => {
    current = views.data('root')
  })
  const page = () => {
    expect(current).not.toBe(LOADING)
    expect(current).toBeDefined()
    return current as IssuePageData
  }
  const parity = () => {
    const value = page(),
      world = views.issues()
    expect(world).not.toBe(LOADING)
    const byId = new Map((world as IssuePageData['issues']).map((row) => [row.id as string, row]))
    expect(value.issues.every((row) => byId.has(row.id))).toBe(true)
    expect(value.presence).toEqual(
      presenceNote(
        value.issue,
        views.attachedSessions('root') as SessionView[],
        byId,
        value.sessions,
      ),
    )
    return value
  }
  try {
    const first = parity()
    expect(first.presence?.text).toBe('Work continued in P-3')
    expect(first.memberSessions.map((row) => row.sessionId)).toEqual(history.map((row) => row.id))
    expect(first.issue.sessionSummary).toEqual({ total: 48, byPhase: { unknown: 48 } })
    const expectedSessions = [
      ...history.map((row) => row.id),
      'tip-agent',
      'born-away',
      'born-shell',
    ].sort(
      (a, b) =>
        pool.queries.orderKey(a).localeCompare(pool.queries.orderKey(b)) || a.localeCompare(b),
    )
    expect(first.sessions.map((row) => row.sessionId)).toEqual(expectedSessions)
    const reads = vi.spyOn(pool, 'row')
    expect(views.data('root')).toBe(first)
    expect(reads.mock.calls).toEqual([])
    pool.apply({ type: 'update', rows: [issue('root', { readAt: '2026-10-04T12:00:00Z' })] })
    expect(page().issue.readAt).toBe('2026-10-04T12:00:00Z')
    expect(page().memberSessions).toBe(first.memberSessions)
    expect(page().sessions).toBe(first.sessions)
    expect(reads.mock.calls.filter(([kind]) => kind === 'worktree')).toEqual([])
    parity()

    pool.apply({ type: 'update', rows: [seat('history-000', { title: 'Renamed' })] })
    expect(parity().memberSessions[0]?.title).toBe('Renamed')
    pool.apply({
      type: 'update',
      rows: [
        seat('history-000', {
          status: 'running',
          archived: false,
          agentState: { phase: 'working' },
          lastActiveAt: '2026-10-04T13:00:00Z',
        }),
      ],
    })
    expect(parity().presence).toBeNull()
    expect(page().issue.sessionSummary).toEqual({ total: 48, byPhase: { working: 1, unknown: 47 } })
    expect(page().issue.unread).toBe(true)
    pool.apply({ type: 'update', rows: [seat('history-000', { issueId: 'tip' })] })
    expect(parity().memberSessions.map((row) => row.sessionId)).toEqual(
      history.slice(1).map((row) => row.id),
    )
    expect(page().issue.sessionSummary).toEqual({ total: 47, byPhase: { unknown: 47 } })
    expect(page().sessions.map((row) => row.sessionId)).toEqual(expectedSessions)
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'history-001', value: undefined }] })
    expect(parity().memberSessions).toHaveLength(46)
    pool.apply({ type: 'update', rows: [seat('history-001')] })
    expect(parity().memberSessions).toHaveLength(47)

    pool.apply({ type: 'update', rows: [issue('hop', { ...hop.value, archived: true })] })
    expect(parity().presence?.kind).toBe('done')
    pool.apply({ type: 'update', rows: [hop] })
    expect(parity().presence?.kind).toBe('moved')
    pool.apply({ type: 'update', rows: [issue('tip', { ...tip.value, deletedAt: old })] })
    expect(parity().presence?.text).toBe('Work continued in P-1')
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'tip', value: undefined }] })
    expect(parity().presence?.text).toBe('Work continued in P-1')
    pool.apply({ type: 'update', rows: [tip] })
    expect(parity().presence?.kind).toBe('moved')
    pool.apply({ type: 'update', rows: [issue('root', { supersededBy: 'tip' })] })
    expect(parity().presence?.text).toBe('Work continued in P-3')

    pool.apply({ type: 'replace', rows: [root, history[0]!, worktrees[0]!] })
    expect(parity().memberSessions.map((row) => row.sessionId)).toEqual(['history-000'])
    expect(page().sessions.map((row) => row.sessionId)).toEqual(['history-000'])
    reads.mockClear()
    stop()
    const pageBuilds = views.stats.pages
    pool.apply({ type: 'update', rows: [seat('history-000', { title: 'After release' })] })
    // The maintained activity index reads the changed resident slot once.
    // Released page/roster readers must add no demands or rebuilds.
    expect(
      reads.mock.calls.filter(
        ([, , mode]) =>
          mode === undefined || mode === 'load' || mode === 'summary' || mode === 'summary-fields',
      ),
    ).toEqual([['session', 'history-000', 'summary-fields']])
    expect(views.stats.pages).toBe(pageBuilds)
    views.dispose()
    expect(views.memberSessions('root')).toBe(LOADING)
    expect(views.attachedSessions('root')).toBe(LOADING)
  } finally {
    stop()
    views.dispose()
    pool.dispose()
    vi.restoreAllMocks()
  }
})

it('keeps page reads bounded at 4x and releases the unrelated menu catalog', () => {
  const measure = (size: number): number => {
    const unrelated = Array.from({ length: size }, (_, n) => issue(`outside-${n}`))
    const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(old) })
    pool.apply({
      type: 'replace',
      rows: [
        issue('root', { parentId: 'parent', stage: 'planning' }),
        issue('parent'),
        issue('child', { parentId: 'root' }),
        ...unrelated,
        {
          kind: 'worktree',
          id: '/repo',
          value: {
            path: '/repo',
            repoId: 'repo',
            repoPath: '/repo',
            prefix: 'P',
            projectRoot: true,
          },
        } as RowRecord,
      ],
    })
    const views = createIssuePageViews(pool)
    const reads = vi.spyOn(pool, 'row')
    const project = vi.spyOn(pool.queries, 'project')
    let current: Loaded<IssuePageData> = LOADING
    const stop = autorun(() => {
      current = views.data('root')
    })
    const first = current as unknown as IssuePageData
    const calls = reads.mock.calls.length
    expect(first.issues.map((row) => row.id).sort()).toEqual(['child', 'parent', 'root'])
    expect(first.hasTargets).toBe(true)
    expect(project).not.toHaveBeenCalled()
    try {
      pool.apply({ type: 'update', rows: [issue('outside-0', { title: 'Unrelated update' })] })
      expect(current).toBe(first)
      expect(views.stats.pages).toBe(1)
      let catalog: Loaded<IssuePageData['issues']> = LOADING
      const stopCatalog = autorun(() => {
        catalog = views.issues()
      })
      expect(
        (catalog as unknown as IssuePageData['issues']).find((row) => row.id === 'outside-0')
          ?.title,
      ).toBe('Unrelated update')
      stopCatalog()
      reads.mockClear()
      pool.apply({ type: 'update', rows: [issue('outside-0', { title: 'After menu close' })] })
      expect(current).toBe(first)
      expect(
        reads.mock.calls.filter(([, , mode]) => mode === undefined || mode === 'summary-fields'),
      ).toEqual([
        ['issue', 'outside-0', 'summary-fields'],
        ['repo', 'repo'],
        ['repo', 'repo'],
      ])
      // Scalar filing joins only the changed issue's named repo; the closed
      // catalog and the addressed page add no demands or rebuilds.
      expect(views.stats.pages).toBe(1)
      return calls
    } finally {
      stop()
      views.dispose()
      pool.dispose()
      vi.restoreAllMocks()
    }
  }
  const small = measure(128)
  expect(small).toBeGreaterThan(0)
  expect(measure(512)).toBe(small)
})

it('keeps named and draft detail independent of unrelated worktree choices at 1x/4x', async () => {
  async function measured(scale: 1 | 4, draft: boolean) {
    const lane = (path: string, patch: object = {}): RowRecord =>
      ({
        kind: 'worktree',
        id: path,
        value: { path, projectRoot: false, ...patch },
      }) as RowRecord
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
    const views = createIssuePageViews(pool),
      reads = vi.spyOn(pool, 'row'),
      keys = vi.spyOn(pool.tables.worktree, 'keys'),
      paint = vi.fn(),
      view = createPoolProjection(pool, () => views.data('root'))
    let stop = () => {}
    const measure = (name: string, action: () => void) =>
      measureWork(async () => insideReader(name, action), { pool })
    const page = () => {
      const value = view.getSnapshot()
      expect(value).not.toBe(LOADING)
      expect(value).toBeDefined()
      return value as IssuePageData
    }
    try {
      const first = await measure('detail first demand', () => {
        view.getSnapshot()
        stop = view.subscribe(paint)
      })
      expect(page().title).toBe(draft ? 'Chosen agent' : 'Named issue')
      expect(page().issue.memberSessionIds).not.toContain('0-nested')
      expect(reads.mock.calls.filter(([kind]) => kind === 'worktree')).toEqual([])
      expect(keys).not.toHaveBeenCalled()
      const repeat = await measure('detail repeated demand', () => {
        view.getSnapshot()
      })
      const before = page()
      const unrelated = await measure('detail unrelated lane update', () =>
        pool.apply({ type: 'update', rows: [lane('/elsewhere/0', { branch: 'changed' })] }),
      )
      expect(page()).toBe(before)
      expect(paint).not.toHaveBeenCalled()
      const changed = await measure('detail named seat changed', () =>
        pool.apply({ type: 'update', rows: [seat('shown', { ...shown.value, name: 'New name' })] }),
      )
      expect(page().title).toBe(draft ? 'New name' : 'Named issue')
      const builds = views.stats.pages
      stop()
      paint.mockClear()
      reads.mockClear()
      keys.mockClear()
      const closed = await measure('detail closed lane update', () =>
        pool.apply({ type: 'update', rows: [lane('/elsewhere/0', { branch: 'closed' })] }),
      )
      expect(views.stats.pages).toBe(builds)
      expect(paint).not.toHaveBeenCalled()
      expect(
        reads.mock.calls.filter(([kind, , mode]) => kind === 'worktree' && mode !== 'mark'),
      ).toEqual([])
      expect(keys).not.toHaveBeenCalled()
      return Object.fromEntries(
        Object.entries({ first, repeat, unrelated, changed, closed }).map(([name, value]) => [
          name,
          value.work,
        ]),
      )
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
    for (const action of Object.keys(first))
      for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
        expect(second[action]?.[counter]).toBe(first[action]?.[counter])
  }
})
