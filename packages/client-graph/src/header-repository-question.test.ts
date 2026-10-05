import { type RepoView, reposToViews } from '@podium/client-core/values'
import { autorun, observable, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../worklist-proto/harness/src/work-meter'
import type { HeaderRows } from './header-schema'
import { MobxPool } from './pool'

const repository = (path: string, extra: Partial<HeaderRows['repository']> = {}): HeaderRows['repository'] => ({
  kind: 'repository', path, worktrees: [], ...extra,
})

it('addresses one repository group with flat rows, derivations and element work at 1x/4x', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const others = Array.from({ length: 128 * scale }, (_, at) => repository(`/other/${at}`, { originUrl: `https://example.test/other-${at}` }))
    const target = repository('/target', { repoId: 'repo_target' as HeaderRows['repository']['repoId'], machineId: 'm1' as HeaderRows['repository']['machineId'], worktrees: [{ path: '/target/feature', branch: 'feature' }] })
    const clone = repository('/clone', { repoId: target.repoId, machineId: 'm2' as HeaderRows['repository']['machineId'] })
    pool.header.apply([
      { kind: 'repository', id: 'target', value: target },
      { kind: 'repository', id: 'clone', value: clone },
      ...others.map((value, at) => ({ kind: 'repository' as const, id: `other-${at}`, value })),
    ])
    const selected = observable.box('/target')
    let value: RepoView | undefined, paints = 0, stop = () => {}
    const ids = vi.spyOn(pool.headerViews, 'ids')
    const measure = (name: string, action: () => void) => measureWork(async () => insideReader(name, () => runInAction(action)), { pool })
    try {
      const first = await measure('launch repository first demand', () => {
        stop = autorun(() => { value = pool.headerViews.repository(selected.get()); paints++ })
      })
      expect(value).toEqual(reposToViews([target, clone])[0])
      expect(first.work.rows).toBe(2)
      const before = paints
      const unrelated = await measure('other repository branch update', () => pool.header.apply([{ kind: 'repository', id: 'other-17', value: { ...others[17]!, branch: 'changed' } }]))
      expect(paints).toBe(before)
      expect(unrelated.work.rows).toBe(0)
      const rekey = await measure('other repository origin update', () => pool.header.apply([{ kind: 'repository', id: 'other-17', value: { ...others[17]!, originUrl: 'https://example.test/moved' } }]))
      expect(paints).toBe(before)
      const branch = await measure('selected repository branch update', () => pool.header.apply([{ kind: 'repository', id: 'target', value: { ...target, branch: 'next' } }]))
      expect(value?.worktrees[0]?.branch).toBe('next')
      expect(branch.work.rows).toBe(2)
      const select = await measure('select another repository path', () => selected.set('/other/23'))
      expect(value?.path).toBe('/other/23')
      expect(select.work.rows).toBe(1)
      const missing = await measure('select absent repository path', () => selected.set('/absent'))
      expect(value).toBeUndefined()
      expect(missing.work.rows).toBe(0)
      const returnToTarget = await measure('return to repository group', () => selected.set('/target'))
      expect(value?.machines).toHaveLength(2)
      const linked = await measure('one repository links the selected path', () => pool.header.apply([{ kind: 'repository', id: 'other-24', value: { ...others[24]!, worktrees: [{ path: '/target' }] } }]))
      expect(value).toBeUndefined()
      const unlink = await measure('remove that linked path', () => pool.header.apply([{ kind: 'repository', id: 'other-24', value: others[24] }]))
      expect(value?.path).toBe('/target')
      stop()
      const closed = await measure('repository update after consumer closes', () => pool.header.apply([{ kind: 'repository', id: 'target', value: { ...target, branch: 'closed' } }]))
      expect(closed.work.rows).toBe(0)
      expect(ids).not.toHaveBeenCalled()
      const control = await measure('planted whole repository launch lookup', () => {
        const all = pool.headerViews.ids('repository').flatMap((id) => {
          const row = pool.headerViews.row('repository', id)
          return row ? [row] : []
        })
        expect(reposToViews(all).find((repo) => repo.path === '/target')?.path).toBe('/target')
      })
      expect(control.work.rows).toBe(128 * scale + 2)
      samples.push({ scale, actions: { first, unrelated, rekey, branch, select, missing, returnToTarget, linked, unlink, closed }, control })
    } finally { stop(); ids.mockRestore(); pool.dispose() }
  }
  console.info('[launch repository question work1x4x]', JSON.stringify(samples))
  for (const name of ['first', 'unrelated', 'rekey', 'branch', 'select', 'missing', 'returnToTarget', 'linked', 'unlink', 'closed'] as const)
    for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(samples[1]!.actions[name].work[counter], `${name}:${counter}`).toBe(samples[0]!.actions[name].work[counter])
  for (const counter of ['rows', 'elements', 'visits'] as const)
    expect(samples[1]!.control.work[counter]).toBeGreaterThan(samples[0]!.control.work[counter] ?? 0)
})

it('preserves source order, canonical paths, normalized origins and distinct originless repositories', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const rows = [
    repository('/first', { originUrl: 'git@example.test:org/project.git', machineId: 'm1' as HeaderRows['repository']['machineId'] }),
    repository('/second', { originUrl: 'https://example.test/org/project', machineId: 'm2' as HeaderRows['repository']['machineId'] }),
    repository('/local', { machineId: 'm1' as HeaderRows['repository']['machineId'] }),
    repository('/local', { machineId: 'm2' as HeaderRows['repository']['machineId'] }),
  ]
  const ids = rows.map((_, at) => `repo-${at}`)
  pool.header.apply(rows.map((value, at) => ({ kind: 'repository' as const, id: ids[at]!, value })))
  const check = (order: readonly string[]) => {
    runInAction(() => pool.header.order('repository', order))
    const expected = reposToViews(order.flatMap((id) => {
      const row = pool.headerViews.row('repository', id)
      return row ? [row] : []
    }))
    for (const path of ['/first', '/second', '/local', '/absent'])
      expect(pool.headerViews.repository(path)).toEqual(expected.find((repo) => repo.path === path))
  }
  try {
    check(ids)
    expect(pool.headerViews.repository('/second')).toBeUndefined()
    check([...ids].reverse())
    expect(pool.headerViews.repository('/first')).toBeUndefined()
    check(['repo-0', 'repo-2'])
    check([])
    check(ids)
    pool.header.apply([{ kind: 'repository', id: 'repo-0', value: undefined }])
    check(ids.slice(1))
    expect(pool.headerViews.repository('/second')?.path).toBe('/second')
    pool.header.clear()
    expect(pool.headerViews.repository('/second')).toBeUndefined()
    pool.header.apply([{ kind: 'repository', id: 'new', value: repository('/new') }])
    expect(pool.headerViews.repository('/new')?.path).toBe('/new')
  } finally { pool.dispose() }
})

it('suppresses linked standalone scans globally and reassigns canonical groups on addressed updates', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const parent = repository('/parent', { worktrees: [{ path: '/linked' }] })
  const linked = repository('/linked', { originUrl: 'https://example.test/shared' })
  const clone = repository('/clone', { originUrl: linked.originUrl })
  pool.header.apply([
    { kind: 'repository', id: 'linked', value: linked },
    { kind: 'repository', id: 'clone', value: clone },
    { kind: 'repository', id: 'parent', value: parent },
  ])
  let value: RepoView | undefined
  const stop = autorun(() => { value = pool.headerViews.repository('/clone') })
  try {
    expect(value).toEqual(reposToViews([linked, clone, parent]).find((repo) => repo.path === '/clone'))
    expect(pool.headerViews.repository('/linked')).toBeUndefined()
    pool.header.apply([{ kind: 'repository', id: 'parent', value: { ...parent, worktrees: [] } }])
    expect(value).toBeUndefined()
    expect(pool.headerViews.repository('/linked')?.worktrees).toHaveLength(2)
    pool.header.apply([{ kind: 'repository', id: 'linked', value: { ...linked, repoId: 'separate' as HeaderRows['repository']['repoId'] } }])
    expect(value?.path).toBe('/clone')
    pool.header.apply([{ kind: 'repository', id: 'clone', value: { ...clone, path: '/renamed' } }])
    expect(value).toBeUndefined()
    expect(pool.headerViews.repository('/renamed')?.path).toBe('/renamed')
  } finally { stop(); pool.dispose() }
})
