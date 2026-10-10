import { expect, it } from 'vitest'
import { observable, runInAction } from 'mobx'
import { MobxPool } from './pool'
import { headerEntities } from './header-entities'
import { createLaunchWorkPicker } from './launch-option-views'
import { LOADING } from './loading'
import { isGone } from './lookup'
import { COMMAND_ENTITIES, type CommandLaunchRows } from './command-launch-schema'

it('uses repository request truth to distinguish loading, an empty answer and a removed source', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const rows = observable.map<string, object>(undefined, { deep: false })
  const window = { reposLoaded: false } as CommandLaunchRows['commandWindow']
  const catalog: CommandLaunchRows['commandCatalog'] = { repositories: [], repos: [], worktrees: [], machines: [], issues: [], sessions: [] }
  pool.sources.register(COMMAND_ENTITIES, { read: (kind, id) => rows.get(`${kind}:${id}`) as never, dispose() {} })
  const picker = createLaunchWorkPicker(pool)
  try {
    runInAction(() => { rows.set('commandWindow:window', window); rows.set('commandCatalog:catalog', catalog); headerEntities(pool).order('repository', []) })
    expect(picker.repositoryAnswer).toBe(LOADING)
    runInAction(() => rows.set('commandWindow:window', { ...window, reposLoaded: true }))
    expect(picker.repositoryAnswer).toEqual([])
    runInAction(() => rows.delete('commandCatalog:catalog'))
    expect(isGone(picker.repositoryAnswer)).toBe(true)
  } finally { pool.dispose() }
})
