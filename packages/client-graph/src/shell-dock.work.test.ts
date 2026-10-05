import type { IssueViewModel } from '@podium/client-core/replica'
import { asSessionId } from '@podium/model/browser'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { legacyShellSnapshot } from '../diagnostics/shell-check'
import { shellFixture } from '../diagnostics/shell-fixture'
import { insideReader, measureWork } from '../../worklist-proto/harness/src/work-meter'
import type { HeaderRows } from './header-schema'
import { shellViews } from './shell-views'
import { LOADING } from './worklist/rollup'

function fixture(scale: 1 | 4) {
  const f = shellFixture(40)
  const count = 128 * scale
  // Every issue competes at the active path. The winner remains the named
  // issue; reading a containing-candidate bucket is still collection work.
  f.pool.apply({
    type: 'update',
    rows: Array.from({ length: count }, (_, index) => ({
      kind: 'issue' as const,
      id: `containing-${index}`,
      value: {
        ...f.issues[1]!,
        id: `containing-${index}`,
        seq: index + 100,
        parentId: null,
      } as IssueViewModel,
    })) as never,
  })
  const root = f.state().repos[0]!
  const order = { ...f.shipOrders[1]!, id: 'extra-0' }
  f.change({
    repos: [
      { ...root, worktrees: [...root.worktrees, ...Array.from({ length: count }, (_, index) => ({
        path: `/synthetic/project/unused-${index}`,
      }))] },
      ...Array.from({ length: count }, (_, index) => ({
        ...root,
        repoId: `other-${index}` as typeof root.repoId,
        path: `/unrelated/${index}`,
        worktrees: [],
      })),
    ],
    shipOrders: [...f.shipOrders, ...Array.from({ length: count }, (_, index) => ({
      ...order,
      id: `extra-${index}`,
    }))],
  })
  return { ...f, count, order }
}

it('keeps cold dock lookup work constant across 1x/4x collections', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const f = fixture(scale)
    try {
      const { value, work } = await measureWork(
        async () => insideReader('cold shell dock', () => shellViews(f.pool).dock()),
        { pool: f.pool },
      )
      expect(value).toMatchObject({ shipping: {
        unfinishedCount: f.count + 3, decisionCount: f.count + 1,
      } })
      samples.push({ scale, rows: work.rows, elements: work.elements, derivations: work.derivations })
    } finally {
      f.pool.dispose()
    }
  }
  console.info('[shell dock cold work 1x/4x]', JSON.stringify(samples))
  expect(samples[1]!.rows).toBe(samples[0]!.rows)
  expect(samples[1]!.elements).toBeLessThanOrEqual(samples[0]!.elements + 4)
  expect(samples[1]!.derivations).toBe(samples[0]!.derivations)
})

it('bounds dock and shipping reader work at 1x/4x candidate, worktree and order counts', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const f = fixture(scale), views = shellViews(f.pool)
    const row = vi.spyOn(f.pool, 'row')
    const indexed = vi.spyOn(f.pool.queries, 'indexed')
    let stop = () => {}
    const output: unknown[] = []
    const measure = (action: () => void) => measureWork(async () => action(), { pool: f.pool })
    try {
      const cold = await measure(() => insideReader('cold shell dock', () => views.dock()))
      const observed = await measure(() => {
        stop = autorun(() => output.push([views.dock(), views.shipping()]))
      })
      expect(views.dock()).toMatchObject({
        scope: { repoId: 'shell-repo', repoPath: '/synthetic/project' },
        gitIssue: { id: f.issues[1]!.id },
        mailIssueId: f.issues[0]!.id,
        shipping: { unfinishedCount: f.count + 3, decisionCount: f.count + 1 },
      })
      const pane = await measure(() => f.change({ paneA: asSessionId(f.fileTabs[0]!.id) }))
      expect(views.dock()).toMatchObject({
        active: { issueId: f.issues[1]!.id },
        gitIssue: { id: f.issues[1]!.id },
        mailIssueId: f.issues[1]!.id,
      })
      const order = await measure(() => f.pool.header.apply([{
        kind: 'shipOrder', id: f.order.id, value: { ...f.order, humanState: 'waiting' },
      }]))
      expect(views.shipping()).toEqual({ unfinishedCount: f.count + 3, decisionCount: f.count })
      const repo = await measure(() => f.pool.header.apply([{
        kind: 'repository', id: JSON.stringify(['shell-machine', '/synthetic/project']),
        value: { ...f.state().repos[0]!, repoId: 'other-scope' as HeaderRows['repository']['repoId'] },
      }]))
      expect(views.dock()).toMatchObject({ scope: { repoId: 'other-scope', repoPath: '/synthetic/project' } })
      expect(views.shipping()).toEqual({ unfinishedCount: 0, decisionCount: 0 })
      const issue = await measure(() => f.pool.apply({
        type: 'update', rows: [{ kind: 'issue', id: f.issues[1]!.id,
          value: { ...f.issues[1]!, archived: true } }] as never,
      }))
      expect(views.dock()).toHaveProperty('mailIssueId', 'containing-0')
      const before = output.length
      row.mockClear()
      const unrelated = await measure(() => f.pool.header.apply([{
        kind: 'shipOrder', id: f.order.id, value: { ...f.order, humanState: 'shipped' },
      }]))
      expect(output).toHaveLength(before)
      expect(row).not.toHaveBeenCalled()
      expect(indexed.mock.calls.some(([question]) => question.kind === 'containingIssues')).toBe(false)
      // Catalogues are acquired only by an explicitly opened queue/shipping panel.
      expect(views.dock()).toMatchObject({ issues: [], shipOrders: [], shipLanes: [] })
      const catalog = views.dock(true)
      expect(catalog && catalog !== LOADING ? catalog.shipOrders.length : 0).toBe(f.count + 4)
      expect(catalog && catalog !== LOADING ? catalog.shipLanes : []).toEqual(f.shipLanes)
      samples.push({ scale, cold: cold.work, observed: observed.work, pane: pane.work,
        order: order.work, repo: repo.work, issue: issue.work, unrelated: unrelated.work })
    } finally {
      stop()
      row.mockRestore()
      indexed.mockRestore()
      f.pool.dispose()
    }
  }
  console.info('[shell dock work 1x/4x]', JSON.stringify(samples))
  for (const step of ['cold', 'observed', 'pane', 'order', 'repo', 'issue', 'unrelated'] as const) {
    expect(samples[1]![step].rows, `${step} row demand`).toBe(samples[0]![step].rows)
    expect(samples[1]![step].elements, `${step} collection work`).toBeLessThanOrEqual(
      samples[0]![step].elements + 4,
    )
    expect(samples[1]![step].derivations, `${step} derivations`).toBe(samples[0]![step].derivations)
  }
})

it('preserves dock scope path, group order, machine, linked scan and fallback semantics', () => {
  const f = shellFixture(), views = shellViews(f.pool)
  const root = f.state().repos[0]!
  const repos = [
    { ...root, worktrees: [{ path: '/synthetic/project/w1' }] },
    { ...root, path: '/clone', worktrees: [{ path: '/clone/nested' }] },
    { ...root, repoId: 'deeper' as typeof root.repoId, path: '/synthetic/project/w1' },
    { ...root, repoId: 'wildcard' as typeof root.repoId, path: '/wild/', machineId: undefined, worktrees: [] },
  ]
  let stop = () => {}
  try {
    f.change({ paneA: asSessionId(f.fileTabs[0]!.id), repos })
    stop = autorun(() => views.dock())
    const check = (cwd: string, machineId: typeof root.machineId, scans = repos) => {
      f.change({ repos: scans, fileTabs: [{ ...f.fileTabs[0]!, worktreePath: cwd,
        scope: { kind: 'worktree', root: cwd, ...(machineId ? { machineId } : {}) } }] })
      const expected = legacyShellSnapshot(f.state(), f.issues).sections.find(section => section.key === 'dock')!
      const actual = views.dock()
      expect(actual).not.toBe(LOADING)
      expect(actual && actual !== LOADING ? actual.scope : null).toEqual(expected.fields.scope)
    }
    check('/synthetic/project/w1/deep', root.machineId)
    check('/clone/nested/deep', root.machineId)
    check('/clone/nested/deep', undefined)
    check('/wild/child', root.machineId)
    check('/synthetic/project/w1/deep', 'another-machine' as typeof root.machineId)
    check('/synthetic/project-sibling', root.machineId)
    check('/clone/nested/deep', root.machineId, [...repos].reverse())
    check('/synthetic/project/w1/deep', root.machineId, [])
  } finally {
    stop()
    f.pool.dispose()
  }
})
