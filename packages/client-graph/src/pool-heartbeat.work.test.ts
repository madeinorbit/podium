import { asMachineId } from '@podium/model/browser'
import { expect, it } from 'vitest'
import { insideArm, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { enableDebugNames } from './debug-name'
import { MobxPool } from './pool'
import { SettingsSource, type SettingsOwner } from './settings-source'
import { settingsRepositoryId, type SettingsRows } from './settings-schema'
import type { RowRecord } from './shared/source'

enableDebugNames()
const old = '2020-01-01T00:00:00Z'
const stamp = '2026-10-03T12:00:00Z'

/** Apply-only reproduction of the POD-5643 pool heartbeat fixture. Only the
 * source's keyed input port is synthetic. Two offered repositories stay fixed
 * while standalone worktree rows, external roots and session history grow. */
function fixture(scale: 1 | 4) {
  const worktrees = Array.from({ length: 128 * scale }, (_, index) => ({
    path: `/external/worktree-${index}`, branch: 'main',
  }))
  const repos: SettingsRows['settingsRepository'][] = [
    { path: '/project', machineId: asMachineId('host'), kind: 'repository', branch: 'main', worktrees },
    { path: '/other', machineId: asMachineId('host'), kind: 'repository', branch: 'main', worktrees: [] },
    ...worktrees.map(tree => ({ ...tree, machineId: asMachineId('host'), kind: 'worktree' as const, worktrees: [] })),
  ]
  const machines: SettingsRows['settingsMachine'][] = [{
    id: asMachineId('host'), name: 'Host', hostname: 'host', online: true,
    lastSeenAt: stamp, use: 'granted', availability: { daemon: true, server: false, supervisor: false, epoch: 'test' },
    serviceAssignment: { server: false, agentExecution: true },
  }]
  const lists = {
    repos: new Map(repos.map(repo => [settingsRepositoryId(repo), repo])),
    machines: new Map(machines.map(machine => [machine.id as string, machine])),
  }
  const ids = { repos: [...lists.repos.keys()], machines: [...lists.machines.keys()] }
  const listeners = new Map<string, Set<(change: { ids: readonly string[]; order: boolean }) => void>>()
  const owner = {
    listIds: (name: keyof typeof lists) => ids[name],
    listRow: (name: keyof typeof lists, id: string) => lists[name].get(id),
    onList(name: string, listener: (change: { ids: readonly string[]; order: boolean }) => void) {
      let group = listeners.get(name)
      if (!group) listeners.set(name, group = new Set())
      group.add(listener)
      return () => { group!.delete(listener) }
    },
  } as unknown as SettingsOwner
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
    load: () => undefined, schedule: () => () => {},
  })
  pool.sources.register(['settingsCatalog', 'settingsRepository', 'settingsMachine'], new SettingsSource(owner))
  const session = (id: string, cwd: string, lastActiveAt = old): RowRecord => ({
    kind: 'session', id, value: { sessionId: id, cwd, lastActiveAt, createdAt: old,
      agentKind: 'codex', status: 'live', archived: false },
  } as RowRecord)
  pool.apply({ type: 'replace', rows: [
    session('visible', worktrees[0]!.path, stamp),
    ...worktrees.map((tree, index) => session(`history-${index}`, tree.path)),
  ] })
  const publish = (name: keyof typeof lists, id: string, order = false) => {
    for (const listener of listeners.get(name) ?? []) listener({ ids: [id], order })
  }
  return { pool, repos, lists, ids, listeners, publish, session }
}

async function measured(scale: 1 | 4) {
  const f = fixture(scale)
  try {
    const heartbeat = await measureWork(async () => {
      insideArm(() => f.pool.apply({ type: 'update', rows: [
        f.session('visible', f.repos[0]!.worktrees[0]!.path, '2026-10-04T12:00:00Z'),
      ] }))
    }, { pool: f.pool, trace: true })
    expect(f.pool.row('session', 'visible')).toMatchObject({ lastActiveAt: '2026-10-04T12:00:00Z' })
    return { work: heartbeat.work, sites: [...heartbeat.sites!].sort((a, b) => b[1] - a[1]).slice(0, 20) }
  } finally { f.pool.dispose() }
}

it('measures pool apply alone for one heartbeat at 1x/4x', async () => {
  const one = await measured(1), four = await measured(4)
  console.info('[pool apply heartbeat work]', JSON.stringify({ one, four }))
}, 120_000)
