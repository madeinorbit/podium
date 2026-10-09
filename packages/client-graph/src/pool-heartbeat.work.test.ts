import { omitGone } from './lookup'
import { asMachineId } from '@podium/model/browser'
import { expect, it } from 'vitest'
import { autorun, Reaction } from 'mobx'
import { ARM_CODE, insideArm, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { enableDebugNames } from './debug-name'
import { MobxPool } from './pool'
import { SettingsSource, type SettingsOwner } from './settings-source'
import { settingsRepositoryId, type SettingsRows } from './settings-schema'
import type { RowRecord } from './shared/source'
import { createColdIndex } from './shared/cold-index'
import { SCHEMA } from './shared/schema'

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

async function measured(scale: 1 | 4, demand: boolean) {
  const f = fixture(scale)
  // Retain scalar query demand without running a downstream reader on writes.
  // The measured arm is only pool.apply, including its invalidation work.
  let invalidations = 0
  const observer = new Reaction('probe:activity', () => { invalidations++ })
  const questions = f.repos.filter(repo => repo.kind === 'repository').map(repo => ({
    kind: 'commandRootActivity' as const, roots: [repo.path, ...repo.worktrees.map(tree => tree.path)],
  }))
  if (demand) observer.track(() => {
    for (const question of questions) f.pool.queries.activity(question)
  })
  try {
    const heartbeat = await measureWork(async () => {
      insideArm(() => f.pool.apply({ type: 'update', rows: [
        f.session('visible', f.repos[0]!.worktrees[0]!.path, '2026-10-04T12:00:00Z'),
      ] }))
    }, { pool: f.pool })
    expect(omitGone(f.pool.row('session', 'visible'))).toMatchObject({ lastActiveAt: '2026-10-04T12:00:00Z' })
    expect(f.pool.queries.activity(questions[0]!)).toBe(Date.parse('2026-10-04T12:00:00Z'))
    expect(invalidations).toBe(demand ? 1 : 0)
    return heartbeat.work
  } finally { observer.dispose(); f.pool.dispose() }
}

it.each([false, true])('keeps one apply heartbeat flat at 1x/4x (retained demand: %s)', async demand => {
  const one = await measured(1, demand), four = await measured(4, demand)
  console.info('[pool apply heartbeat work]', JSON.stringify({ demand, one, four }))
  expect(four.elementsBy[ARM_CODE]).toBeLessThanOrEqual(one.elementsBy[ARM_CODE]!)
  expect(four.rows).toBe(one.rows)
  expect(four.visits).toBeLessThanOrEqual(one.visits)
  expect(four.derivations).toBe(0)
}, 120_000)

const session = (id: string, cwd: string, patch: object = {}): RowRecord => ({
  kind: 'session', id,
  value: { sessionId: id, cwd, createdAt: old, lastActiveAt: stamp,
    agentKind: 'codex', status: 'live', archived: false, ...patch },
} as RowRecord)

function suppliedPool(external: boolean, rows: RowRecord[]) {
  const index = external ? createColdIndex(SCHEMA) : undefined
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
    ...(index ? { cold: () => index } : {}), load: () => undefined, schedule: () => () => {},
  })
  const apply = (event: Parameters<MobxPool['apply']>[0]) => { index?.apply(event); pool.apply(event) }
  apply({ type: 'replace', rows })
  return { pool, apply }
}

it.each([false, true])('tracks only addressed activity paths, exact matches and agent membership (external source: %s)', external => {
  const f = suppliedPool(external, [session('moving', '/target/child', { agentKind: 'shell' })])
  const base = { kind: 'commandRootActivity' as const, roots: ['/target'] }
  const values = { within: [] as number[], exact: [] as number[], agents: [] as number[], other: [] as number[] }
  const stops = [
    autorun(() => values.within.push(f.pool.queries.activity(base))),
    autorun(() => values.exact.push(f.pool.queries.activity({ ...base, match: 'exact' }))),
    autorun(() => values.agents.push(f.pool.queries.activity({ ...base, agentsOnly: true }))),
    autorun(() => values.other.push(f.pool.queries.activity({ ...base, roots: ['/target2'] }))),
  ]
  const update = (row: RowRecord) => f.apply({ type: 'update', rows: [row] })
  try {
    expect(values.within).toEqual([Date.parse(stamp)])
    expect(values.exact).toEqual([0])
    expect(values.agents).toEqual([0])
    update(session('moving', '/target/child', { agentKind: 'shell', title: 'Renamed' }))
    expect(values.within).toHaveLength(1)
    update(session('moving', '/target/child', { agentKind: 'shell', lastActiveAt: '2027-01-01T00:00:00Z' }))
    expect(values.within.at(-1)).toBe(Date.parse('2027-01-01T00:00:00Z'))
    expect(values.exact).toEqual([0])
    expect(values.agents).toEqual([0])
    update(session('moving', '/target/child'))
    expect(values.agents.at(-1)).toBe(Date.parse(stamp))
    update(session('moving', '/target'))
    expect(values.exact.at(-1)).toBe(Date.parse(stamp))
    update(session('moving', '/elsewhere'))
    expect(values.within.at(-1)).toBe(0)
    expect(values.exact.at(-1)).toBe(0)
    expect(values.agents.at(-1)).toBe(0)
    expect(values.other).toEqual([0])
    f.apply({ type: 'replace', rows: [session('replacement', '/target')] })
    expect(values.within.at(-1)).toBe(Date.parse(stamp))
    update({ kind: 'session', id: 'replacement', value: undefined })
    expect(values.within.at(-1)).toBe(0)
  } finally { for (const stop of stops) stop(); f.pool.dispose() }
})

it.each([false, true])('restores activity subscriptions when a parked session becomes visible (external source: %s)', external => {
  const resume = { kind: 'codex-thread', value: 'activity-twins' }
  const parked = session('parked', '/target/child', { resume, issueId: 'selected', status: 'exited', stoppedAt: old })
  const winner = session('winner', '/other', { resume, issueId: 'selected', status: 'hibernated' })
  const f = suppliedPool(external, [parked, winner])
  const values: number[] = []
  const stop = autorun(() => values.push(f.pool.queries.activity({ kind: 'commandRootActivity', roots: ['/target'] })))
  try {
    expect(values).toEqual([0])
    f.apply({ type: 'update', rows: [{ kind: 'session', id: 'winner', value: undefined }] })
    expect(values.at(-1)).toBe(Date.parse(stamp))
    f.apply({ type: 'update', rows: [winner] })
    expect(values.at(-1)).toBe(0)
  } finally { stop(); f.pool.dispose() }
})
