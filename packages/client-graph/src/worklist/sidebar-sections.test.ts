/** The tasks-only sidebar (POD-2156): which project sections show, how they
 * are labelled and ordered, and which task rows they hold, on web and phone. */
import { autorun, runInAction } from 'mobx'
import { afterEach, describe, expect, it } from 'vitest'
import { MobxPool } from '../pool'
import { type SidebarState, sidebarNested, sidebarView } from './sidebar'
import { worklistView } from './view-model'

const stamp = '2026-10-05T12:00:00Z'
const pools: MobxPool[] = []
afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose()
})

type Row = { kind: 'issue' | 'session' | 'worktree'; id: string; value: unknown }
const root = (name: string, projectIndex: number, patch: object = {}): Row => ({
  kind: 'worktree',
  id: `/code/${name}`,
  value: {
    path: `/code/${name}`,
    repoPath: `/code/${name}`,
    repoId: name,
    repoName: `Repo ${name}`,
    isMain: true,
    projectIndex,
    projectRoot: true,
    ...patch,
  },
})
const task = (id: string, repo: string, patch: object = {}): Row => ({
  kind: 'issue',
  id,
  value: {
    id,
    seq: 1,
    title: id,
    stage: 'in_progress',
    audience: 'human',
    repoId: repo,
    repoPath: `/code/${repo}`,
    createdAt: stamp,
    updatedAt: stamp,
    deps: [],
    ...patch,
  },
})
const session = (id: string, issueId: string, patch: object = {}): Row => ({
  kind: 'session',
  id,
  value: {
    sessionId: id,
    issueId,
    cwd: '/code/alpha',
    agentKind: 'codex',
    status: 'live',
    archived: false,
    lastActiveAt: stamp,
    agentState: { phase: 'working', since: stamp },
    ...patch,
  },
})

function poolWith(rows: Row[]): MobxPool {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pools.push(pool)
  pool.apply({ type: 'replace', rows: rows as never })
  return pool
}
const update = (pool: MobxPool, rows: Row[]) =>
  runInAction(() => pool.apply({ type: 'update', rows: rows as never }))
const bands = (pool: MobxPool, state: SidebarState = {}) =>
  sidebarView(pool)
    .sections(state)
    .bands.map(({ key, label, rowIds }) => ({ key, label, rowIds }))

describe('project sections', () => {
  it('shows a registered project with no tasks as an empty section named after the repo', () => {
    const pool = poolWith([root('alpha', 0)])
    expect(bands(pool)).toEqual([{ key: 'alpha', label: 'Repo alpha', rowIds: [] }])
  })

  it('labels a section by its first task once it has one, and drops a repo opted out of the list', () => {
    const pool = poolWith([
      root('alpha', 0),
      root('beta', 1, { projectRoot: false }),
      task('t1', 'alpha'),
    ])
    expect(bands(pool)).toEqual([{ key: 'alpha', label: 'alpha', rowIds: ['t1'] }])
  })

  it('puts pinned repos first, and keeps a pinned repo whose only checkout is pinned elsewhere', () => {
    const pool = poolWith([root('alpha', 0), root('beta', 1)])
    expect(bands(pool).map((band) => band.key)).toEqual(['alpha', 'beta'])
    expect(bands(pool, { pinnedRepos: ['/code/beta'] }).map((band) => band.key)).toEqual([
      'beta',
      'alpha',
    ])
    const pinnedCheckout = { pinnedWorktrees: ['/code/beta'] }
    expect(bands(pool, pinnedCheckout).map((band) => band.key)).toEqual(['alpha'])
    expect(
      bands(pool, { ...pinnedCheckout, pinnedRepos: ['/code/beta'] }).map((band) => band.key),
    ).toEqual(['beta', 'alpha'])
  })

  it('holds the saved project order, matched through any alias of a section', () => {
    const pool = poolWith([
      root('alpha', 0),
      root('beta', 1, { projectAliases: ['beta', '/code/beta', '/old/beta'] }),
      root('gamma', 2),
    ])
    expect(bands(pool).map((band) => band.key)).toEqual(['alpha', 'beta', 'gamma'])
    expect(bands(pool, { projectOrder: ['gamma', '/old/beta'] }).map((band) => band.key)).toEqual([
      'gamma',
      'beta',
      'alpha',
    ])
  })
})

describe('task rows', () => {
  it('gives a top-level agent task with a live session its own row, and nests one under a human task', () => {
    const pool = poolWith([
      root('alpha', 0),
      task('human', 'alpha'),
      task('top-agent', 'alpha', { audience: 'agent' }),
      session('s-top', 'top-agent'),
      task('child-agent', 'alpha', { audience: 'agent', parentId: 'human' }),
      session('s-child', 'child-agent'),
    ])
    expect(bands(pool)).toEqual([{ key: 'alpha', label: 'alpha', rowIds: ['human', 'top-agent'] }])
    expect(sidebarNested(pool.worklistRow('human')!, pool)).toEqual(['child-agent'])
  })

  /** PIPP-351: started by a coordinator working on a task in another repo, it
   *  hid inside that task. Only a real parent nests a task. */
  it('shows a task started from another repo’s task as a root row in its own section', () => {
    const pool = poolWith([
      root('alpha', 0),
      root('beta', 1),
      task('coordinator', 'alpha'),
      session('s-coordinator', 'coordinator'),
      task('started', 'beta', { startedBySession: 's-coordinator' }),
    ])
    expect(bands(pool)).toEqual([
      { key: 'alpha', label: 'alpha', rowIds: ['coordinator'] },
      { key: 'beta', label: 'beta', rowIds: ['started'] },
    ])
    expect(sidebarNested(pool.worklistRow('coordinator')!, pool)).toEqual([])
  })

  /** POD-2129: archiving a task evicts its row before the server drops its
   *  sessions. In that gap no session may surface as a row, web or phone. */
  for (const leaves of ['archived', 'evicted'] as const) {
    it(`shows nothing for a task ${leaves} while its sessions are still live`, () => {
      const pool = poolWith([
        root('alpha', 0),
        task('t1', 'alpha'),
        session('s1', 't1'),
        session('s2', 't1', { agentKind: 'shell' }),
      ])
      const view = worklistView(pool)
      const rows = () => {
        const sections = view.sections()
        const phone = view.mobileSections()
        return {
          web: [
            ...sections.pinnedIds,
            ...sections.bands.flatMap((band) => [
              ...band.rowIds,
              ...band.snoozedIds,
              ...band.closedIds,
            ]),
          ],
          phone: phone.sectionKeys.flatMap((key) => {
            const section = phone.section(key)
            return [...section.data, ...section.snoozedIds, ...section.closedIds]
          }),
        }
      }
      let seen = rows()
      const stop = autorun(() => {
        seen = rows()
      })
      try {
        expect(seen).toEqual({ web: ['t1'], phone: ['t1'] })
        update(pool, [
          leaves === 'archived'
            ? task('t1', 'alpha', { archived: true })
            : { kind: 'issue', id: 't1', value: undefined },
        ])
        expect(seen).toEqual({ web: [], phone: [] })
      } finally {
        stop()
      }
    })
  }
})
