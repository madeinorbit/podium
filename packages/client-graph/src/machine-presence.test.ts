import { asMachineId } from '@podium/model'
import { autorun } from 'mobx'
import { beforeAll, expect, it } from 'vitest'
import { automationViews } from './automation-views'
import { headerEntities } from './header-entities'
import { headerView } from './header-views'
import { liveFixture } from './live-fixture'
import { requireHere } from './lookup'
import { machineFacts } from './machine-facts'
import { loadSyncedModels } from './models'
import { MobxPool } from './pool'

beforeAll(() => loadSyncedModels())

it('keeps unknown, stale and fresh machine conditions distinct through reconnect and a new epoch', () => {
  const at = '2026-11-20T12:00:00Z'
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(at) })
  const live = liveFixture(pool)
  const source = headerEntities(pool)
  source.apply([
    {
      kind: 'machine',
      id: 'host',
      value: {
        id: 'host',
        name: 'Build machine',
        use: 'granted',
        loggedOutHarnesses: [],
        serviceAssignment: { server: false, agentExecution: true },
      } as never,
    },
  ])
  const machine = requireHere(pool.model('machine', 'host'))
  const states: unknown[] = []
  const stop = autorun(() =>
    states.push({
      presence: machine.presence,
      online: machine.online,
      known: machine.onlineKnown,
      lastSeen: machine.lastSeenAt,
      offline: headerView(pool)
        .offlineMachines()
        .map((m) => m.id),
      factsKnown: machineFacts(machine).onlineKnown,
    }),
  )
  const condition = (online: boolean, epoch = 'boot-a') =>
    live.condition('host', {
      online,
      since: at,
      lastSeenAt: at,
      availability: { epoch, daemon: online, supervisor: online, server: false },
    })
  const expectState = (
    presence: string,
    online: boolean,
    known: boolean,
    offline: string[],
    lastSeen?: string,
  ) =>
    expect(states.at(-1)).toEqual({ presence, online, known, offline, lastSeen, factsKnown: known })
  try {
    expectState('Reconnecting', false, false, [])
    condition(true)
    expectState('Online', true, true, [], at)
    live.lost(Date.parse(at) + 1000)
    expectState('Reconnecting', false, false, [], at)
    condition(false, 'boot-b')
    expectState('Offline', false, true, ['host'], at)
    live.lost(Date.parse(at) + 2000)
    expectState('Reconnecting', false, false, [], at)
    condition(true, 'boot-c')
    expectState('Online', true, true, [], at)
  } finally {
    stop()
    pool.dispose()
  }
})

it('saved automation targets use reconnecting separately from fresh offline', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const live = liveFixture(pool)
  headerEntities(pool).apply([
    {
      kind: 'machine',
      id: 'host',
      value: {
        id: 'host',
        name: 'Build machine',
        use: 'granted',
        loggedOutHarnesses: [],
        serviceAssignment: { server: false, agentExecution: true },
      } as never,
    },
  ])
  pool.sources.register(['settingsCatalog', 'settingsRepository'], {
    read: (entity) =>
      entity === 'settingsCatalog'
        ? { machines: ['host'], repositories: ['repo'] }
        : { path: '/project', machineId: asMachineId('host'), kind: 'repository', worktrees: [] },
    dispose() {},
  })
  const view = automationViews(pool)
  const stop = autorun(() => {
    view.targets('/project')
    view.target('saved:/project')
  })
  try {
    live.condition('host', {
      online: true,
      since: null,
      availability: { epoch: 'boot', daemon: true, server: false, supervisor: true },
    })
    expect(view.targets('/project').excluded.reconnecting).toBe(0)
    live.lost(1000)
    expect(view.targets('/project').excluded).toMatchObject({ reconnecting: 1, unreachable: 0 })
    expect(view.target('saved:/project')).toMatchObject({
      label: 'project — reconnecting',
      availability: 'reconnecting',
    })
    live.condition('host', { online: false, since: null })
    expect(view.targets('/project').excluded).toMatchObject({ reconnecting: 0, unreachable: 1 })
    expect(view.target('saved:/project')).toMatchObject({
      label: 'project — machine offline',
      availability: 'unreachable',
    })
  } finally {
    stop()
    pool.dispose()
  }
})
