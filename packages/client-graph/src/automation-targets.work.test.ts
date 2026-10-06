import { asMachineId } from '@podium/model/browser'
import { expect, it } from 'vitest'
import { insideArm, insideReader, measureWork, type WorkCounts } from '../../../tests/worklist/harness/src/work-meter'
import { automationViews } from './automation-views'
import { enableDebugNames } from './debug-name'
import { MobxPool } from './pool'
import { createPoolProjection } from './runtime-pool'
import { SettingsSource, type SettingsOwner } from './settings-source'
import { settingsRepositoryId, type SettingsRows } from './settings-schema'
import type { RowRecord } from './shared/source'

enableDebugNames()
const old = '2020-01-01T00:00:00Z'
const stamp = '2026-10-03T12:00:00Z'

/** Real pool, SettingsSource, activity questions and app projection. Only the
 * source's keyed input port is synthetic. Two offered repositories stay fixed
 * while standalone worktree rows, external roots and session history grow. */
function fixture(scale: 1 | 4) {
  const worktrees = Array.from({ length: 128 * scale }, (_, index) => ({
    path: `/external/worktree-${index}`, branch: 'main',
  }))
  const repos: SettingsRows['settingsRepository'][] = [
    { path: '/project', machineId: asMachineId('host'), kind: 'repository', branch: 'main', worktrees },
    { path: '/other', machineId: asMachineId('host'), kind: 'repository', branch: 'main', worktrees: [] },
    ...worktrees.map(tree => ({ ...tree, machineId: asMachineId('host'), kind: 'worktree', worktrees: [] })),
  ]
  const machines: SettingsRows['settingsMachine'][] = [{
    id: asMachineId('host'), name: 'Host', hostname: 'host', online: true,
    lastSeenAt: stamp, use: 'granted', availability: { daemon: true },
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

async function measured(scale: 1 | 4, plant = false) {
  const f = fixture(scale), view = automationViews(f.pool)
  const read = () => insideReader('automation-form', () => {
    const result = view.targets()
    if (plant) {
      // Identical output with the former all-root recency walk restored.
      for (const repo of f.repos) f.pool.queries.activity({
        kind: 'commandRootActivity', roots: [repo.path, ...repo.worktrees.map(tree => tree.path)],
      })
    }
    return result
  })
  const projection = createPoolProjection(f.pool, read, { name: 'consumer:automation-form' })
  let value!: ReturnType<typeof view.targets>
  let stop = () => {}
  const flush = async () => { for (let step = 0; step < 12; step++) await Promise.resolve() }
  try {
    const open = await measureWork(async () => {
      value = projection.getSnapshot()
      stop = projection.subscribe(() => { value = projection.getSnapshot() })
      await flush()
    }, { pool: f.pool })
    expect(value.pending).toBe(0)
    expect(value.choices.map(choice => choice.value)).toEqual(['/project', '/other', '__global__'])
    const repoId = settingsRepositoryId(f.repos[0]!)
    const catalog = await measureWork(async () => {
      insideArm(() => {
        f.lists.repos.set(repoId, { ...f.repos[0]!, branch: 'updated' })
        f.publish('repos', repoId)
      })
      await flush()
    }, { pool: f.pool })
    const heartbeat = await measureWork(async () => {
      insideArm(() => f.pool.apply({ type: 'update', rows: [
        f.session('visible', f.repos[0]!.worktrees[0]!.path, '2026-10-04T12:00:00Z'),
      ] }))
      await flush()
    }, { pool: f.pool })
    expect(value.choices.map(choice => choice.value)).toEqual(['/project', '/other', '__global__'])
    return { open: open.work, catalog: catalog.work, heartbeat: heartbeat.work }
  } finally {
    stop(); projection.dispose(); f.pool.dispose()
  }
}

const targetWork = (work: WorkCounts, kind: 'rows' | 'derivations' | 'elements') =>
  Object.entries(kind === 'rows' ? work.rowsBy ?? {} : kind === 'derivations' ? work.derivationsBy : work.elementsBy)
    .filter(([name]) => /automations\.|consumer:automation-form/.test(name))
    .reduce((sum, [, count]) => sum + count, 0)

it('measures real automation target open, catalog update and heartbeat at 1x/4x', async () => {
  const one = await measured(1), four = await measured(4)
  console.info('[automation target work]', JSON.stringify({ one, four }))
  if (process.env.PODIUM_AUTOMATION_BASELINE === '1') return
  for (const action of ['catalog', 'heartbeat'] as const)
    for (const kind of ['rows', 'derivations', 'elements'] as const)
      expect(targetWork(four[action], kind), `${action} ${kind} grew with hidden worktrees`).toBeLessThanOrEqual(targetWork(one[action], kind))
  const plantedOne = await measured(1, true), plantedFour = await measured(4, true)
  expect(targetWork(plantedFour.heartbeat, 'elements')).toBeGreaterThan(targetWork(plantedOne.heartbeat, 'elements') * 3)
}, 120_000)
