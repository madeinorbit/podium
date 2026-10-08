import { repoUsageAt, reposToViews } from '@podium/client-core/values'
import { machinePathBasename, machinePathKey, machinePathsEqual, type GitRepositoryWire } from '@podium/model/browser'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { headerEntities } from './header-entities'
import { createLaunchCatalogPicker, createLaunchWorkPicker } from './launch-option-views'
import { MobxPool } from './pool'
import type { RowRecord } from './shared/source'

function fixture(scale: number) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const paths = ['/zeta', '/alpha', '/one/Twin', '/two/Twin']
  const repositories: GitRepositoryWire[] = paths.map(path => ({ kind: 'repository', path,
    worktrees: Array.from({ length: 64 * scale }, (_, i) => ({ path: `${path}/tree-${i}` })),
  }))
  const sessions = [
    { sessionId: 'zeta', cwd: '/zeta', lastActiveAt: '2026-01-02T00:00:00Z' },
    { sessionId: 'alpha', cwd: '/alpha/deeper', lastActiveAt: '2026-01-03T00:00:00Z' },
    { sessionId: 'one', cwd: '/one/Twin', lastActiveAt: '2026-01-01T00:00:00Z' },
    { sessionId: 'two', cwd: '/two/Twin', lastActiveAt: '2026-01-01T00:00:00Z' },
  ]
  pool.apply({ type: 'replace', rows: sessions.map(value => ({ kind: 'session', id: value.sessionId,
    value: { ...value, createdAt: value.lastActiveAt, agentKind: 'codex', status: 'live', archived: false },
  })) as RowRecord[] })
  headerEntities(pool).apply(repositories.map((value, i) => ({ kind: 'repository', id: `r${i}`, value })))
  const pins = { repos: ['/two/Twin', '/one/Twin'], worktrees: [] as string[] }
  pool.sources.register(['commandWindow'], { read: () => ({ pins }) as never, dispose() {} })
  return { pool, repositories, sessions, pins }
}

/** Frozen rules from the live sorter, checked against it before its removal.
 * The oracle uses fixture session data, independently of the pool activity query. */
function legacyOrder(f: ReturnType<typeof fixture>) {
  const roots = f.repositories.filter(repo => repo.kind !== 'worktree')
  const values = roots.map(repo => ({ repo, at: repoUsageAt(repo, f.sessions) }))
  const initialRepoPath = values.reduce<(typeof values)[number] | undefined>((best, value) =>
    !best || value.at > best.at ? value : best, undefined)?.repo.path ?? f.repositories[0]?.path ?? ''
  values.sort((a, b) => b.at - a.at || (machinePathBasename(a.repo.path) || a.repo.path)
    .localeCompare(machinePathBasename(b.repo.path) || b.repo.path, undefined, { sensitivity: 'base' }))
  const projects = reposToViews(f.repositories).map(repo => ({ ...repo,
    worktrees: repo.worktrees.filter(tree => !f.pins.worktrees.some(path => machinePathsEqual(path, tree.path)))
      .map(tree => ({ ...tree, repoName: repo.name, sessions: [], issues: [] })),
  })).filter(repo => f.pins.repos.some(path => machinePathsEqual(path, repo.path)) || repo.worktrees.length)
  const exact = (repo: (typeof projects)[number]) => Math.max(0, ...f.sessions
    .filter(session => [repo.path, ...repo.worktrees.map(tree => tree.path)].some(path => machinePathsEqual(path, session.cwd)))
    .map(session => Date.parse(session.lastActiveAt) || 0))
  const pinOrder = new Map(f.pins.repos.map((path, i) => [machinePathKey(path), i]))
  projects.sort((a, b) => exact(b) - exact(a) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
    (pinOrder.get(machinePathKey(a.path)) ?? f.pins.repos.length) - (pinOrder.get(machinePathKey(b.path)) ?? f.pins.repos.length))
  const paths = reposToViews(f.repositories).map(repo => ({ path: repo.path, at: repoUsageAt(repo, f.sessions) }))
    .sort((a, b) => b.at - a.at || a.path.localeCompare(b.path, undefined, { sensitivity: 'base' })).map(repo => repo.path)
  return { catalog: { initialRepoPath, repoPaths: values.map(value => value.repo.path) }, projects, paths }
}

for (const scale of [1, 4]) it(`matches the live order at open, then freezes usage until reopen at ${scale}x`, async () => {
  const f = fixture(scale)
  const catalog = createLaunchCatalogPicker(f.pool), phone = createLaunchWorkPicker(f.pool)
  catalog.open(); phone.open()
  const expected = legacyOrder(f)
  // 6b75d37794 proved this oracle and these pickers against the live sorter.
  expect(catalog.catalog()).toMatchObject(expected.catalog)
  expect(phone.newWork().repos).toEqual(expected.projects)
  expect(phone.repositoryPaths).toEqual(expected.paths)
  expect(expected.catalog.repoPaths).toEqual(['/alpha', '/zeta', '/one/Twin', '/two/Twin'])
  expect(expected.projects.map(repo => repo.path)).toEqual(['/zeta', '/two/Twin', '/one/Twin', '/alpha'])
  expect(() => expect(catalog.repoPaths).toEqual([...expected.catalog.repoPaths].reverse())).toThrow()
  expect(() => expect(phone.newWork().repos).toEqual([...expected.projects].reverse())).toThrow()
  const stops = [
    autorun(() => insideReader('launcher.launch', () => catalog.catalog())),
    autorun(() => insideReader('launcher.phone', () => { phone.newWork(); phone.repositoryPaths; phone.repositoryActivity('/zeta') })),
  ]
  const query = vi.spyOn(f.pool.queries, 'activity')
  try {
    for (const lastActiveAt of ['2026-01-04T00:00:00Z', '2026-01-05T00:00:00Z']) {
      query.mockClear()
      const cell = await measureWork(async () => f.pool.apply({ type: 'update', rows: [{
        kind: 'session', id: 'two', value: { ...f.sessions[3], lastActiveAt, agentKind: 'codex', status: 'live' },
      }] as RowRecord[] }), { pool: f.pool })
      expect(query).not.toHaveBeenCalled()
      for (const [reader, elements] of Object.entries(cell.work.elementsBy))
        if (/launch\.(?:usage|catalogUsage|activityAt)/.test(reader)) expect(elements, reader).toBe(0)
      expect(catalog.catalog()).toMatchObject(expected.catalog)
      expect(phone.newWork().repos).toEqual(expected.projects)
      expect(phone.repositoryPaths).toEqual(expected.paths)
      console.info('[launcher frozen usage]', JSON.stringify({ scale, lastActiveAt, usageQueries: query.mock.calls.length, elementsBy: cell.work.elementsBy }))
    }
    catalog.open(); phone.open()
    expect(catalog.repoPaths[0]).toBe('/two/Twin')
    expect(catalog.initialRepoPath).toBe('/two/Twin')
    expect(phone.repos[0]?.path).toBe('/two/Twin')
    expect(phone.repositoryPaths[0]).toBe('/two/Twin')
    expect(phone.repositoryActivity('/two/Twin')).toBe(Date.parse('2026-01-05T00:00:00Z'))
    query.mockClear()
    headerEntities(f.pool).apply([
      { kind: 'repository', id: 'new', value: { kind: 'repository', path: '/new', worktrees: [] } },
      { kind: 'repository', id: 'r1', value: undefined },
    ])
    expect(catalog.repoPaths).toEqual(['/two/Twin', '/zeta', '/one/Twin', '/new'])
    expect(phone.repositoryPaths).toEqual(['/two/Twin', '/zeta', '/one/Twin', '/new'])
    expect(phone.repos.map(repo => repo.path)).toEqual(['/two/Twin', '/zeta', '/one/Twin', '/new'])
    expect(query).not.toHaveBeenCalled()
  } finally { stops.forEach(stop => stop()); query.mockRestore(); f.pool.dispose() }
})

it('keeps discovery order for the initial choice while displaying basename ties, including empty/worktree-only catalogs', () => {
  const f = fixture(1)
  const catalog = createLaunchCatalogPicker(f.pool)
  try {
    f.pool.apply({ type: 'replace', rows: [] })
    catalog.open()
    expect(catalog.initialRepoPath).toBe('/zeta')
    expect(catalog.repoPaths).toEqual(['/alpha', '/one/Twin', '/two/Twin', '/zeta'])
    headerEntities(f.pool).apply(f.repositories.map((_, i) => ({ kind: 'repository', id: `r${i}`, value: undefined })))
    catalog.open()
    expect(catalog.catalog()).toMatchObject({ initialRepoPath: '', repoPaths: [] })
    headerEntities(f.pool).apply([{ kind: 'repository', id: 'worktree', value: { kind: 'worktree', path: '/only-tree', worktrees: [] } }])
    catalog.open()
    expect(catalog.catalog()).toMatchObject({ initialRepoPath: '/only-tree', repoPaths: [] })
  } finally { f.pool.dispose() }
})
