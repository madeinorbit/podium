import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../worklist-proto/harness/src/work-meter'
import { createIssuePageViews, type IssuePageData } from './issue-page'
import { MobxPool } from './pool'
import { createColdIndex } from './shared/cold-index'
import { createIssueQuestions } from './shared/issue-questions'
import { SCHEMA } from './shared/schema'
import type { RowRecord, RowSourceEvent } from './shared/source'
import { LOADING, type Loaded } from './worklist/rollup'

const old = '2020-01-01T00:00:00Z'
const repo: RowRecord = { kind: 'worktree', id: 'repo', value: { repoId: 'repo', repoPath: '/repo', prefix: 'REPO' } } as RowRecord
const issue = (id: string, seq: number, path: string, patch: object = {}): RowRecord =>
  ({
    kind: 'issue',
    id,
    value: {
      id,
      seq,
      title: id,
      worktreePath: path,
      repoId: 'repo',
      repoPath: '/repo',
      stage: 'planning',
      createdAt: old,
      updatedAt: old,
      description: '',
      deps: [],
      labels: [],
      archived: false,
      deletedAt: null,
      ...patch,
    },
  }) as RowRecord

it('bounds a file-tab page selection and updates with large histories sharing its exact path', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(old) })
    const target = issue('target', 1, '/shared/src'),
      runner = issue('runner', 2, '/shared/src')
    const samePath = Array.from({ length: 128 * scale }, (_, at) =>
      issue(`history-${at}`, at + 100, '/shared/src'),
    )
    const others = Array.from({ length: 128 * scale }, (_, at) =>
      issue(`other-${at}`, at + 100, `/elsewhere/${at}`),
    )
    pool.apply({
      type: 'replace',
      rows: [repo, target, runner, issue('ancestor', 0, '/shared'), ...samePath, ...others],
    })
    const views = createIssuePageViews(pool),
      ids = vi.spyOn(pool.queries, 'ids')
    let current: Loaded<IssuePageData>,
      paints = 0,
      stop = () => {}
    const measure = (name: string, action: () => void) =>
      measureWork(async () => insideReader(name, () => runInAction(action)), { pool })
    const chosen = () => {
      expect(current).not.toBe(LOADING)
      expect(current).toBeDefined()
      return (current as IssuePageData).issue.id
    }
    try {
      const first = await measure('file-tab issue first demand', () => {
        stop = autorun(() => {
          current = views.panel({ cwd: '/shared/src/file' })
          paints++
        })
      })
      expect(chosen()).toBe('target')
      const point = await measure('repeat addressed containing issue', () => {
        expect(pool.queries.containingIssueId('/shared/src/file')).toBe('target')
        expect(pool.queries.containingIssueId('/shared-sibling/file')).toBeUndefined()
        expect(pool.queries.containingIssueId('/absent')).toBeUndefined()
      })
      expect(point.work.rows).toBe(0)
      const before = paints
      const unrelated = await measure('other path title update', () =>
        pool.apply({
          type: 'update',
          rows: [issue('other-0', 100, '/elsewhere/0', { title: 'Changed' })],
        }),
      )
      expect(paints).toBe(before)
      const peer = await measure('same path history title update', () =>
        pool.apply({
          type: 'update',
          rows: [issue('history-0', 100, '/shared/src', { title: 'Changed' })],
        }),
      )
      expect(paints).toBe(before)
      const peerArchived = await measure('same path history archived', () =>
        pool.apply({
          type: 'update',
          rows: [issue('history-0', 100, '/shared/src', { archived: true })],
        }),
      )
      expect(paints).toBe(before)
      const rank = await measure('selected issue sequence changes', () =>
        pool.apply({ type: 'update', rows: [issue('target', 3, '/shared/src')] }),
      )
      expect(chosen()).toBe('runner')
      const restore = await measure('selected issue sequence restored', () =>
        pool.apply({ type: 'update', rows: [target] }),
      )
      expect(chosen()).toBe('target')
      const moved = await measure('selected issue path changes', () =>
        pool.apply({ type: 'update', rows: [issue('target', 1, '/moved')] }),
      )
      expect(chosen()).toBe('runner')
      const returned = await measure('selected issue path returns', () =>
        pool.apply({ type: 'update', rows: [target] }),
      )
      expect(chosen()).toBe('target')
      const archived = await measure('selected issue archived', () =>
        pool.apply({
          type: 'update',
          rows: [issue('target', 1, '/shared/src', { archived: true })],
        }),
      )
      expect(chosen()).toBe('runner')
      const readmitted = await measure('selected issue readmitted', () =>
        pool.apply({ type: 'update', rows: [target] }),
      )
      expect(chosen()).toBe('target')
      const deleted = await measure('selected issue deleted', () =>
        pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'target', value: undefined }] }),
      )
      expect(chosen()).toBe('runner')
      expect(ids.mock.calls.some(([question]) => question.kind === 'containingIssues')).toBe(false)
      stop()
      const builds = views.stats.panels
      const closed = await measure('closed file-tab issue owner update', () =>
        pool.apply({ type: 'update', rows: [issue('runner', 4, '/shared/src')] }),
      )
      expect(views.stats.panels).toBe(builds)
      const control = await measure('planted whole-path-history winner scan', () => {
        let best: { id: string; seq: number; worktreePath: string } | undefined
        for (const id of pool.queries.ids({ kind: 'containingIssues', cwd: '/shared/src/file' })) {
          const value = pool.row('issue', id, 'summary') as Loaded<{
            id: string
            seq: number
            worktreePath: string
            archived?: boolean
            deletedAt?: string | null
          }>
          if (!value || value === LOADING || value.archived || value.deletedAt) continue
          if (
            !best ||
            value.worktreePath.length > best.worktreePath.length ||
            (value.worktreePath.length === best.worktreePath.length && value.seq < best.seq)
          )
            best = value
        }
        expect(best?.id).toBe('runner')
      })
      samples.push({
        scale,
        actions: {
          first,
          point,
          unrelated,
          peer,
          peerArchived,
          rank,
          restore,
          moved,
          returned,
          archived,
          readmitted,
          deleted,
          closed,
        },
        control,
      })
    } finally {
      stop()
      ids.mockRestore()
      views.dispose()
      pool.dispose()
    }
  }
  console.info('[file-tab issue work1x4x]', JSON.stringify(samples))
  for (const action of [
    'first',
    'point',
    'unrelated',
    'peer',
    'peerArchived',
    'rank',
    'restore',
    'moved',
    'returned',
    'archived',
    'readmitted',
    'deleted',
    'closed',
  ] as const)
    for (const counter of ['rows', 'derivations', 'elements'] as const)
      expect(samples[1]!.actions[action].work[counter], `${action}:${counter}`).toBe(
        samples[0]!.actions[action].work[counter],
      )
  expect(samples[1]!.control.work.rows).toBeGreaterThan(samples[0]!.control.work.rows ?? 0)
  expect(samples[1]!.control.work.elements).toBeGreaterThan(samples[0]!.control.work.elements)
})

it('preserves path boundaries, trailing roots, insertion ties and source-forked winner facts', () => {
  const questions = createIssueQuestions()
  questions.set('root', { worktreePath: '/', seq: 0 })
  questions.set('parent', { worktreePath: '/repo', seq: 1 })
  questions.set('z-first', { worktreePath: '/repo/sub', seq: 9 })
  questions.set('a-second', { worktreePath: '/repo/sub', seq: 9 })
  questions.set('trailing', { worktreePath: '/repo/sub/', seq: 10 })
  questions.set('archived', { worktreePath: '/repo/sub/deeper', seq: 0, archived: true })
  questions.set('deleted', { worktreePath: '/repo/sub/deeper', seq: 0, deletedAt: old })
  expect(questions.containingIssueId('/repo/sub')).toBe('z-first')
  expect(questions.containingIssueId('/repo/sub/file')).toBe('trailing')
  expect(questions.containingIssueId('/repo/submarine/file')).toBe('parent')
  expect(questions.containingIssueId('/repository/file')).toBe('root')
  expect(questions.containingIssueId('relative/file')).toBeUndefined()
  const fork = questions.fork()
  fork.set('trailing', undefined)
  fork.set('z-first', { worktreePath: '/repo/sub', seq: 11 })
  expect(fork.containingIssueId('/repo/sub/file')).toBe('a-second')
  expect(questions.containingIssueId('/repo/sub/file')).toBe('trailing')
  fork.set('a-second', undefined)
  fork.set('a-second', { worktreePath: '/repo/sub', seq: 11 })
  expect(fork.containingIssueId('/repo/sub/file')).toBe('z-first')
  fork.clear()
  expect(fork.containingIssueId('/repo/sub/file')).toBeUndefined()
  fork.set('new', { worktreePath: '/new', seq: 1, parentId: 'root', stage: 'done' })
  fork.set('cancelled', { parentId: 'root', stage: 'planning', closedReason: 'cancelled' })
  expect(fork.containingIssueId('/new/file')).toBe('new')
  expect(fork.childCounts('root')).toEqual({ childCount: 2, childDoneCount: 2 })
})

it('honors resident path/eligibility overlays, cold source changes and replacement without a catalog demand', () => {
  let source = createColdIndex(SCHEMA)
  const a = issue('a', 1, '/shared'),
    b = issue('b', 2, '/shared')
  source.apply({ type: 'replace', rows: [a, b] })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(old) }, undefined, {
    cold: () => source,
    load: () => undefined,
    schedule: () => () => {},
  })
  pool.apply({ type: 'replace', rows: [] })
  const seen: (string | undefined)[] = []
  const stop = autorun(() => seen.push(pool.queries.containingIssueId('/shared/file')))
  const publish = (event: RowSourceEvent) => {
    source.apply(event)
    pool.apply(event)
  }
  try {
    expect(seen).toEqual(['a'])
    pool.apply({ type: 'update', rows: [issue('a', 1, '/elsewhere')] })
    expect(seen.at(-1)).toBe('b')
    const before = seen.length
    // A cold source update cannot displace a resident edit at the same key.
    source.apply({ type: 'update', rows: [issue('a', 0, '/shared')] })
    pool.apply({ type: 'update', rows: [] })
    expect(seen).toHaveLength(before)
    publish({ type: 'update', rows: [issue('b', 2, '/shared', { archived: true })] })
    expect(seen.at(-1)).toBeUndefined()
    pool.apply({ type: 'update', rows: [issue('pending', 3, '/shared')] })
    expect(seen.at(-1)).toBe('pending')
    pool.apply({ type: 'update', rows: [issue('pending', 3, '/shared', { deletedAt: old })] })
    expect(seen.at(-1)).toBeUndefined()
    source = createColdIndex(SCHEMA)
    source.apply({ type: 'replace', rows: [issue('replacement', 7, '/shared')] })
    pool.apply({ type: 'replace', rows: [] })
    expect(seen.at(-1)).toBe('replacement')
  } finally {
    stop()
    pool.dispose()
  }
})

it('keeps explicit issue and attached-session precedence over the file-tab path winner', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(old) })
  const views = createIssuePageViews(pool)
  pool.apply({
    type: 'replace',
    rows: [
      repo,
      issue('path', 1, '/shared'),
      issue('explicit', 2, '/elsewhere'),
      {
        kind: 'session',
        id: 'attached',
        value: {
          sessionId: 'attached',
          issueId: 'explicit',
          refIssueId: 'explicit',
          cwd: '/shared',
          archived: false,
          agentKind: 'codex',
          status: 'live',
          lastActiveAt: old,
          createdAt: old,
        },
      } as RowRecord,
      {
        kind: 'session',
        id: 'unattached',
        value: {
          sessionId: 'unattached',
          cwd: '/shared',
          archived: false,
          agentKind: 'codex',
          status: 'live',
          lastActiveAt: old,
          createdAt: old,
        },
      } as RowRecord,
    ],
  })
  try {
    const id = (value: Loaded<IssuePageData>) =>
      value && value !== LOADING ? value.issue.id : value
    expect(id(views.panel({ issueId: 'explicit', cwd: '/shared/file' }))).toBe('explicit')
    expect(id(views.panel({ sessionId: 'attached', cwd: '/shared/file' }))).toBe('explicit')
    expect(views.panel({ sessionId: 'unattached', cwd: '/shared/file' })).toBeUndefined()
    expect(id(views.panel({ sessionId: 'missing', cwd: '/shared/file' }))).toBe('path')
  } finally {
    views.dispose()
    pool.dispose()
  }
})
