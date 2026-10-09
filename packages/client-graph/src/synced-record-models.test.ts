import { EMPTY_PENDING } from '../../../tests/worklist/shared/src/row-source'
import type { ReplicaAddressedBatch, ReplicaKind } from '@podium/client-core/replica'
import { machineViewsFromWire } from '@podium/client-core/values'
import type { MachineWire } from '@podium/model'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { createWorklistPool } from './create'
import { headerEntities } from './header-entities'
import { automationViews } from './automation-views'
import { workflowMachines } from './workflow-views'
import { here, isGone, requireHere } from './lookup'
import { fixedLocals } from './shared/locals-source'
import { createRowSource } from './shared/row-source'

const stamp = '2026-10-09T12:00:00Z'
const machine = { id: 'host', name: 'Workstation', hostname: 'synthetic', online: true,
  lastSeenAt: stamp, use: 'granted', updateChannelOverride: null, targetVersion: '1.0',
  loggedOutHarnesses: ['codex'] }
const automation = { id: 'scheduled', name: 'Daily task', enabled: true, repoPath: '/synthetic',
  scheduleKind: 'cron', cron: '0 9 * * *', runAt: null, targetSessionId: null,
  agentKind: 'codex', model: 'auto', effort: 'auto', prompt: 'Synthetic task', sessionMode: 'fresh',
  nextRunAt: stamp, lastRunAt: null, createdAt: stamp }
const run = { id: 'fire', automationId: 'scheduled', firedAt: stamp, sessionId: null,
  outcome: 'missed', detail: 'Offline' }
const examples = [['machine', 'machines', machine], ['automation', 'automations', automation],
  ['automationRun', 'automationRuns', run]] as const

function fixture() {
  const rows = new Map<ReplicaKind, Map<string, Readonly<Record<string, unknown>>>>()
  for (const [, kind, row] of examples) rows.set(kind, new Map([[row.id, row]]))
  rows.set('sessions', new Map([['seat', { sessionId: 'seat', cwd: '/synthetic', title: 'Spawned session',
    status: 'live', archived: false, agentKind: 'codex', lastActiveAt: stamp, createdAt: stamp }]]))
  let addressed: (batch: ReplicaAddressedBatch) => void = () => {}
  const enumerate = vi.fn((kind: ReplicaKind) => [...(rows.get(kind)?.values() ?? [])])
  const discovery: readonly never[] = []
  const feed = createRowSource({ principal: { userId: 'operator' },
    readLocal: () => discovery, onLocals: () => () => {} }, {
    rows: enumerate, row: (kind, id) => rows.get(kind)?.get(id),
    subscribeAddressedBatch(listener) { addressed = listener; return () => {} },
  }, { pending: EMPTY_PENDING })
  const handle = createWorklistPool(feed.source, fixedLocals({ selectedIssueId: null, coarseNow: Date.parse(stamp) }).source)
  handle.pool.sources.register(['settingsCatalog', 'automationCatalog'], {
    read(entity) { return entity === 'settingsCatalog'
      ? { machines: ['host'], repositories: [] } : { automations: ['scheduled'], runs: ['fire'] } },
    dispose() {},
  })
  return { pool: handle.pool, feed, enumerate,
    publish(kind: ReplicaKind, id: string, value: Readonly<Record<string, unknown>> | undefined) {
      if (value) rows.get(kind)!.set(id, value)
      else rows.get(kind)!.delete(id)
      addressed({ type: 'update', rows: [{ kind, id }] })
      feed.flush()
    },
    replace() { addressed({ type: 'replace', reason: 'rescope' }); feed.flush() },
    dispose() { handle.dispose(); feed.dispose() },
  }
}

it('schema-installed model fields preserve every old wire answer on the same fixtures', () => {
  const f = fixture()
  try {
    for (const [entity, , row] of examples) {
      const model = requireHere(f.pool.model(entity, row.id))
      if (process.env.PODIUM_RECORD_NEGATIVE_CONTROL && entity === 'machine')
        Object.defineProperty(model, 'name', { value: 'Wrong answer' })
      for (const field of Object.keys(row))
        expect(Reflect.get(model, field), `${entity}.${field}`).toEqual(Reflect.get(row, field))
      expect(model.row).toBe(f.pool.row(entity, row.id))
      expect(f.pool.model(entity, row.id)).toBe(model)
    }
    expect(headerEntities(f.pool).tables.machine).toBe(f.pool.tables.machine)
  } finally { f.dispose() }
})

it.each(examples)('one %s publication updates every view holding its shared model without enumerating', (entity, kind, row) => {
  const f = fixture(), model = requireHere(f.pool.model(entity, row.id))
  const field = entity === 'automationRun' ? 'detail' : 'name'
  const first: unknown[] = [], second: unknown[] = []
  const stops = [autorun(() => first.push(Reflect.get(model, field))),
    autorun(() => second.push(Reflect.get(here(f.pool.model(entity, row.id)) ?? {}, field)))]
  try {
    f.enumerate.mockClear()
    f.publish(kind, row.id, { ...row, [field]: 'Changed everywhere' })
    expect(first).toEqual([Reflect.get(row, field), 'Changed everywhere'])
    expect(second).toEqual(first)
    expect(f.pool.model(entity, row.id)).toBe(model)
    expect(f.enumerate).not.toHaveBeenCalled()
    f.publish(kind, row.id, undefined)
    expect(isGone(f.pool.model(entity, row.id))).toBe(true)
  } finally { for (const stop of stops) stop(); f.dispose() }
})

it('live machine presence and replicated facts share one model across replacement and removal', () => {
  const f = fixture()
  try {
    const model = requireHere(f.pool.model('machine', 'host'))
    f.pool.ingestLiveMachines([{ id: 'host', value: { ...machine, name: 'Live rename', online: false } }])
    expect(Reflect.get(model, 'name')).toBe('Live rename')
    expect(Reflect.get(model, 'online')).toBe(false)
    expect(Reflect.get(model, 'loggedOutHarnesses')).toEqual(['codex'])
    f.replace()
    expect(f.pool.model('machine', 'host')).toBe(model)
    expect(Reflect.get(model, 'name')).toBe(machine.name)
    f.publish('machines', 'host', undefined)
    expect(here(f.pool.model('machine', 'host'))).toBeUndefined()
  } finally { f.dispose() }
})

it('workflow placement, automation definitions, history runs and session links read the shared identities', () => {
  const f = fixture()
  try {
    const placement = workflowMachines(f.pool)
    const oldPlacement = machineViewsFromWire([machine as unknown as MachineWire])
    const values = (views: typeof oldPlacement) => views.map(view => ({ id: view.machine.id,
      name: view.machine.name, grants: view.grants, availability: view.availability }))
    expect(values(placement.views)).toEqual(values(oldPlacement))
    expect(placement.views[0]!.machine).toBe(f.pool.model('machine', 'host'))
    expect(automationViews(f.pool).list().automations[0]).toBe(f.pool.model('automation', 'scheduled'))
    expect(automationViews(f.pool).run('fire')).toBe(f.pool.model('automationRun', 'fire'))
    expect(automationViews(f.pool).session('seat')).toBe(f.pool.model('session', 'seat'))
    f.publish('machines', 'host', { ...machine, name: 'Renamed host', online: false })
    expect(placement.views[0]!.machine.name).toBe('Renamed host')
    expect(values(workflowMachines(f.pool).views)).toEqual(values(machineViewsFromWire([{ ...machine, name: 'Renamed host', online: false } as unknown as MachineWire])))
  } finally { f.dispose() }
})
