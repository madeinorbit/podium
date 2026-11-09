import { EMPTY_PENDING } from '../../../tests/worklist/shared/src/row-source'
import type { ReplicaAddressedBatch, ReplicaKind } from '@podium/client-core/replica'
import { machineViewsFromWire } from '@podium/client-core/values'
import { type FixtureRecord, machineRecords } from '@podium/client-core/test-support/machine-records'
import { AutomationRunWire, AutomationWire, MachineAccessWire, MachineProjection, MachineWire } from '@podium/model'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { createWorklistPool } from './create'
import { liveFixture } from './live-fixture'
import { headerEntities } from './header-entities'
import { automationViews } from './automation-views'
import { workflowMachines } from './workflow-views'
import { shellViews } from './shell-views'
import { SCHEMA } from './shared/schema'
import { here, isGone, requireHere } from './lookup'
import { fixedLocals } from './shared/locals-source'
import { createRowSource } from './shared/row-source'

const stamp = '2026-10-09T12:00:00Z'
const machine = { ...MachineWire.parse({ id: 'host', name: 'Workstation', hostname: 'synthetic', online: true,
  lastSeenAt: stamp, use: 'granted', updateChannelOverride: null, targetVersion: '1.0',
  revokedAt: null, supersededBy: null, supersedable: true, owned: true, transferable: true,
  unowned: false, adoptable: false, podiumManaged: true,
  presenceSource: 'supervisor', serviceAssignment: { server: false, agentExecution: true },
  services: { server: { policy: 'disabled', state: 'stopped', observedAt: stamp },
    agentExecution: { policy: 'enabled', state: 'available', observedAt: stamp } },
  availability: { epoch: 'synthetic', server: false, daemon: true, supervisor: true },
  daemonReadiness: { state: 'ready', reason: 'Synthetic fixture', quarantinedBindings: 0 },
  components: ['daemon'], inventory: { os: 'linux', arch: 'x64', agents: [], tools: [] },
  harnessVersions: [{ harness: 'codex', version: '1.0', firstSeen: stamp, lastSeen: stamp }],
  deliveryCaps: ['synthetic'], serverMoveEligibility: { eligible: true },
  updateChannel: 'stable', appVersion: '1.0', wireSchemaDigest: 'synthetic', installKind: 'source',
  buildReportedAt: stamp, versionState: 'current', targetUnavailableReason: null }),
  loggedOutHarnesses: ['codex'], custodian: 'mem_custodian', serverMoveSupported: true }
// The listing above as the app receives it (POD-6644): the shared record, my
// access row, and the presence facts as a LiveStore condition.
const [machineRecord, machineAccess] = machineRecords('operator', machine) as [FixtureRecord, FixtureRecord]
const projection = machineRecord.value as Readonly<Record<string, unknown>> & { id: string }
const presence = (value: typeof machine) => ({ online: value.online, since: null, lastSeenAt: value.lastSeenAt,
  presenceSource: value.presenceSource, availability: value.availability, daemonReadiness: value.daemonReadiness })
const automation = { id: 'scheduled', name: 'Daily task', enabled: true, repoPath: '/synthetic',
  scheduleKind: 'cron', cron: '0 9 * * *', runAt: null, targetSessionId: null,
  agentKind: 'codex', model: 'auto', effort: 'auto', prompt: 'Synthetic task', sessionMode: 'fresh',
  nextRunAt: stamp, lastRunAt: null, createdAt: stamp }
const run = { id: 'fire', automationId: 'scheduled', firedAt: stamp, sessionId: null,
  outcome: 'missed', detail: 'Offline' }
const examples = [['machine', 'machines', projection], ['automation', 'automations', automation],
  ['automationRun', 'automationRuns', run]] as const

function fixture() {
  const rows = new Map<ReplicaKind, Map<string, Readonly<Record<string, unknown>>>>()
  for (const [, kind, row] of examples) rows.set(kind, new Map([[row.id, row]]))
  rows.set('machineAccess', new Map([[machineAccess.entityId, machineAccess.value]]))
  rows.set('sessions', new Map([['seat', { sessionId: 'seat', cwd: '/synthetic', title: 'Spawned session',
    status: 'live', archived: false, agentKind: 'codex', lastActiveAt: stamp, createdAt: stamp }]]))
  let addressed: (batch: ReplicaAddressedBatch) => void = () => {}
  const enumerate = vi.fn((kind: ReplicaKind) => [...(rows.get(kind)?.values() ?? [])])
  const feed = createRowSource({ principal: { userId: 'operator' } }, {
    rows: enumerate, row: (kind, id) => rows.get(kind)?.get(id),
    subscribeAddressedBatch(listener) { addressed = listener; return () => {} },
  }, { pending: EMPTY_PENDING })
  const handle = createWorklistPool(feed.source, fixedLocals({ selectedIssueId: null, coarseNow: Date.parse(stamp) }).source)
  handle.pool.sources.register(['settingsCatalog', 'automationCatalog'], {
    read(entity) { return entity === 'settingsCatalog'
      ? { machines: ['host'], repositories: [] } : { automations: ['scheduled'], runs: ['fire'] } },
    dispose() {},
  })
  const live = liveFixture(handle.pool)
  live.condition('host', presence(machine) as never)
  return { pool: handle.pool, feed, enumerate, live,
    /** A machine listing as its record and its live condition. */
    publishMachine(value: typeof machine) {
      const [next] = machineRecords('operator', value) as [FixtureRecord]
      live.condition('host', presence(value) as never)
      rows.get('machines')!.set('host', next.value)
      addressed({ type: 'update', rows: [{ kind: 'machines', id: 'host' }] })
      feed.flush()
    },
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
    // Every stored machine fact is a schema field: the record's and my access
    // row's (the live condition is the model's own, POD-6644).
    const live = new Set(['services', 'lastSeenAt', 'presenceSource', 'availability', 'daemonReadiness'])
    const machineFields = [...new Set([...Object.keys(MachineProjection.shape), ...Object.keys(MachineAccessWire.shape)])]
      .filter(field => field !== 'userId' && field !== 'machineId' && !live.has(field))
    expect(Object.keys(SCHEMA.machine.fields).sort()).toEqual(machineFields.sort())
    // The model answers every field the old listing had.
    const host = requireHere(f.pool.model('machine', 'host'))
    for (const field of Object.keys(machine))
      expect(Reflect.get(host, field), `machine.${field}`).toEqual(Reflect.get(machine, field))
    for (const [entity, , row] of examples) {
      if (entity !== 'machine') {
        const wireFields = Object.keys((entity === 'automation' ? AutomationWire : AutomationRunWire).shape)
        expect(Object.keys(SCHEMA[entity].fields).sort()).toEqual(wireFields.sort())
        expect(Object.keys(row).sort()).toEqual(wireFields.sort())
      }
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
    f.publishMachine({ ...machine, name: 'Live rename', online: false })
    expect(Reflect.get(model, 'name')).toBe('Live rename')
    expect(Reflect.get(model, 'online')).toBe(false)
    expect(Reflect.get(model, 'loggedOutHarnesses')).toEqual(['codex'])
    f.replace()
    expect(f.pool.model('machine', 'host')).toBe(model)
    expect(Reflect.get(model, 'name')).toBe('Live rename')
    f.live.online('host', true)
    expect(Reflect.get(model, 'online')).toBe(true)
    f.publish('machines', 'host', undefined)
    expect(here(f.pool.model('machine', 'host'))).toBeUndefined()
  } finally { f.dispose() }
})

it('machine settings, workflow placement, automations, runs and session links read the shared identities', () => {
  const f = fixture()
  try {
    const placement = workflowMachines(f.pool)
    const oldPlacement = machineViewsFromWire([machine as unknown as MachineWire])
    const values = (views: typeof oldPlacement) => views.map(view => ({ id: view.machine.id,
      name: view.machine.name, grants: view.grants, availability: view.availability }))
    expect(values(placement.views)).toEqual(values(oldPlacement))
    expect(placement.views[0]!.machine).toBe(f.pool.model('machine', 'host'))
    const settingsMachines = shellViews(f.pool).machines()
    expect(settingsMachines[0]).toBe(f.pool.model('machine', 'host'))
    expect(automationViews(f.pool).list().automations[0]).toBe(f.pool.model('automation', 'scheduled'))
    expect(automationViews(f.pool).run('fire')).toBe(f.pool.model('automationRun', 'fire'))
    expect(automationViews(f.pool).session('seat')).toBe(f.pool.model('session', 'seat'))
    f.publishMachine({ ...machine, name: 'Renamed host', online: false })
    expect(placement.views[0]!.machine.name).toBe('Renamed host')
    expect(settingsMachines[0]!.name).toBe('Renamed host')
    expect(values(workflowMachines(f.pool).views)).toEqual(values(machineViewsFromWire([{ ...machine, name: 'Renamed host', online: false } as unknown as MachineWire])))
  } finally { f.dispose() }
})
