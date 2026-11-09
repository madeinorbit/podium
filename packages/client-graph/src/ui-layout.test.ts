import { fixtureUi } from '@podium/client-core/test-support/ui'
import { asUserId, layoutRowId } from '@podium/model'
import { autorun, runInAction } from 'mobx'
import { afterEach, describe, expect, it } from 'vitest'
import { here } from './lookup'
import { MissionScreen } from './mission-screen'
import { MobileTasksBoard } from './mobile-tasks'
import { MobxPool } from './pool'
import { PhoneWorkFilters } from './worklist/phone'

const user = asUserId('member-1'),
  close: Array<() => void> = []
afterEach(() => {
  for (const dispose of close.splice(0)) dispose()
})
function devices() {
  const pools = [
    new MobxPool({ selectedIssueId: null, coarseNow: 0 }),
    new MobxPool({ selectedIssueId: null, coarseNow: 0 }),
  ]
  for (const pool of pools) {
    pool.apply({ type: 'replace', rows: [] })
    pool.bindLayout({
      read: (key) => here(pool.model('userLayout', layoutRowId(user, key)))?.value,
      write: (key, value) =>
        runInAction(() => {
          for (const target of pools)
            target.apply({
              type: 'update',
              rows: [
                {
                  kind: 'userLayout',
                  id: layoutRowId(user, key),
                  value: { id: layoutRowId(user, key), userId: user, key, value } as never,
                },
              ],
            })
        }),
    })
    close.push(() => pool.dispose())
  }
  const screens = pools.map((pool) => new MissionScreen(pool, 'mission-1'))
  const boards = pools.map(
    (pool) =>
      new MobileTasksBoard(pool, {
        filter: {},
        showDone: false,
        ordering: 'priority',
        showAgentTasks: false,
        expanded: [],
      }),
  )
  return { pools, screens, boards }
}

describe('synced view options and device state', () => {
  it('mission filters and show-done follow the user to another device and a reopened view', () => {
    const { pools, screens } = devices()
    const observed: unknown[] = []
    const stop = autorun(() => observed.push([screens[1]!.full.filter, screens[1]!.full.showDone]))
    screens[0]!.full.setFilter('needs-you')
    expect(observed.at(-1)).toEqual(['needs-you', false])
    screens[0]!.full.setShowDone(true)
    expect(observed.at(-1)).toEqual(['all', true])
    screens[0]!.setQuery('temporary search')
    screens[0]!.setArchivedOpen(true)
    screens[0]!.close()
    const reopened = new MissionScreen(pools[0]!, 'mission-1')
    expect(reopened.query).toBe('')
    expect(reopened.archivedOpen).toBe(false)
    expect(reopened.full.showDone).toBe(true)
    reopened.close()
    screens[1]!.close()
    stop()
  })
  it('phone task filters, show-done and ordering read their one synced home', () => {
    const { pools, boards, screens } = devices()
    boards[0]!.setFilter({ priority: 1, status: 'ready' })
    boards[0]!.toggleShowDone()
    boards[0]!.setOrdering('updated')
    expect(boards[1]!.filter).toEqual({ priority: 1, status: 'ready' })
    expect(boards[1]!.showDone).toBe(true)
    expect(boards[1]!.ordering).toBe('updated')
    const options = here(
      pools[0]!.model('userLayout', layoutRowId(user, 'phone.tasks.options')),
    )?.value
    expect(options).not.toHaveProperty('ordering')
    expect(
      here(pools[0]!.model('userLayout', layoutRowId(user, 'issues.display')))?.value,
    ).toContain('updated')
    boards[0]!.search('one opening')
    const reopened = new MobileTasksBoard(pools[0]!, {
      filter: {},
      showDone: false,
      ordering: 'priority',
      showAgentTasks: false,
      expanded: [],
    })
    expect(reopened.query).toBe('')
    expect(reopened.showDone).toBe(true)
    expect(reopened.filter).toEqual(boards[1]!.filter)
    for (const screen of screens) screen.close()
  })
  it('phone lane choices travel while pane geometry stays on its own device', () => {
    const { pools, screens } = devices()
    const filters = pools.map((pool) => {
      const value = new PhoneWorkFilters()
      value.bind(pool)
      return value
    })
    filters[0]!.setLane('snoozed')
    expect(filters[1]!.lane).toBe('snoozed')
    const left = fixtureUi(),
      right = fixtureUi()
    left.setSelectedWorktree('/left')
    left.openSessionTab('session-left' as never)
    right.setSelectedWorktree('/right')
    right.openSessionTab('session-right' as never)
    left.splitWorkspacePane(left.workspace.focusedPaneId, 'row')
    expect(left.split).toBe(true)
    expect(right.split).toBe(false)
    expect(right.selectedWorktree).toBe('/right')
    left.dispose()
    right.dispose()
    for (const screen of screens) screen.close()
  })
})
