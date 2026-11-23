import { expect, it } from 'vitest'
import { observable, runInAction } from 'mobx'
import { MobxPool } from './pool'
import { createLaunchWorkPicker } from './launch-option-views'
import { LOADING } from './loading'
import { isGone } from './lookup'
import { COMMAND_ENTITIES, type CommandLaunchRows } from './command-launch-schema'

it('answers loading while the catalog is on its way, then an empty answer, then a removed source', () => {
  // "Loading" is the pool's own on-its-way state (POD-6644): no flag in the window.
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const rows = observable.map<string, object>(undefined, { deep: false })
  const window = {} as CommandLaunchRows['commandWindow']
  const catalog: CommandLaunchRows['commandCatalog'] = { repositories: [], repos: [], worktrees: [], machines: [], issues: [], sessions: [] }
  const answered = observable.box(false)
  pool.sources.register(COMMAND_ENTITIES, {
    read: (kind, id) =>
      (rows.get(`${kind}:${id}`) ?? (kind === 'commandCatalog' && !answered.get() ? LOADING : undefined)) as never,
    dispose() {},
  })
  const picker = createLaunchWorkPicker(pool)
  try {
    runInAction(() => { rows.set('commandWindow:window', window) })
    expect(picker.repositoryAnswer).toBe(LOADING)
    runInAction(() => { rows.set('commandCatalog:catalog', catalog); answered.set(true) })
    expect(picker.repositoryAnswer).toEqual([])
    runInAction(() => rows.delete('commandCatalog:catalog'))
    expect(isGone(picker.repositoryAnswer)).toBe(true)
  } finally { pool.dispose() }
})
