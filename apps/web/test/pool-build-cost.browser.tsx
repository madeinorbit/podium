/** Synthetic construction microscope. Production constructors/readers only;
 * separate turns allow controlled GC between phases without changing product.
 * No operator endpoint or data import exists in this fixture. */
import { createClientRuntime, type ClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { asUserId } from '@podium/model/browser'
import { MobxPool } from '@podium/client-graph'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { PoolRelations } from '@podium/client-graph/relations'
import { Residency } from '@podium/client-graph/residency'
import { VisibleCollection } from '@podium/client-graph/worklist/visible'
import { SidebarRosterIndex } from '@podium/client-graph/worklist/sidebar-roster'
import { autorun, computed, ObservableMap } from 'mobx'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createHeaderFixture } from './header-fixture'

const query = new URLSearchParams(location.search)
const history = Number(query.get('history') ?? 5000)
const resident = Number(query.get('resident') ?? 600)
const displayed = Number(query.get('displayed') ?? 24)
const arm = query.get('arm') ?? 'pool'
const detailed = query.get('detail') === '1'
const fixedNow = Date.parse('2026-09-20T12:00:00Z')
Date.now = () => fixedNow
const fixture = createHeaderFixture(history + resident)
// Keep the resident set exact. Cold issues finished long ago; their sessions
// ended and were read long ago, so neither the clock nor a guest warms them.
for (const [key, record] of fixture.records) {
  const value = record.value as Record<string, unknown>
  const id = String(record.entityId)
  if (id.startsWith('synthetic-guest')) { fixture.records.delete(key); continue }
  const index = Number(id.split('-').at(-1))
  const cold = index >= resident
  if (record.entity === 'issue' || record.entity === 'issueProjection') {
    const { parentId, deferUntil, ...rest } = value
    fixture.records.set(key, { ...record, value: { ...rest, stage: cold ? 'done' : 'in_progress',
      closedAt: cold ? '2026-08-01T00:00:00Z' : null, closedReason: cold ? 'done' : null,
      tuckedAt: null, pinned: false, readAt: '2026-09-19T00:00:00Z',
      gitState: cold ? { merged: true } : undefined } })
  } else if (record.entity === 'session') {
    fixture.records.set(key, { ...record, value: { ...value, status: cold ? 'exited' : 'live',
      stoppedAt: cold ? '2026-08-01T00:00:00Z' : undefined,
      lastActiveAt: '2026-08-01T00:00:00Z', readAt: '2026-09-19T00:00:00Z',
      agentState: { phase: cold ? 'ended' : 'idle', since: '2026-08-01T00:00:00Z', idle: { kind: 'done' } } } })
  } else if (record.entity === 'issueUserState') {
    fixture.records.set(key, { ...record, value: { ...value, pinned: false, tuckedAt: null, readAt: '2026-09-19T00:00:00Z' } })
  }
}
type Times = Record<string, { selfMs: number; calls: number }>
let times: Times = {}, stack: { name: string; began: number; children: number }[] = []
function span<T>(name: string, fn: () => T): T {
  if (!detailed) return fn()
  const frame = { name, began: performance.now(), children: 0 }
  stack.push(frame)
  try { return fn() } finally {
    const elapsed = performance.now() - frame.began
    stack.pop()
    if (stack.length) stack[stack.length - 1]!.children += elapsed
    const entry = times[name] ??= { selfMs: 0, calls: 0 }
    entry.selfMs += elapsed - frame.children; entry.calls++
  }
}
// Measurement-only wrappers. These are never installed by product code.
function wrap(proto: object, names: string[], phase: string) {
  for (const name of names) {
    const original = Reflect.get(proto, name)
    if (typeof original !== 'function') throw new Error(`Missing measured method ${name}`)
    Object.defineProperty(proto, name, { configurable: true, writable: true,
      value: function(this: unknown, ...args: unknown[]) { return span(phase, () => original.apply(this, args)) } })
  }
}
if (detailed) {
  wrap(MobxPool.prototype, ['apply'], 'pool ingest and scheduling')
  wrap(MobxPool.prototype, ['object'], 'model construction')
  wrap(PoolRelations.prototype, ['changed', 'flush'], 'relations')
  wrap(Residency.prototype, ['reindex', 'place', 'replaced', 'settle'], 'residency')
  wrap(VisibleCollection.prototype, ['track', 'file'], 'filing reactions and indexes')
  wrap(SidebarRosterIndex.prototype, ['flush', 'fileOwner', 'fileWorktree'], 'roster indexes')
  wrap(ObservableMap.prototype, ['set'], 'observable map slots')
  wrap(Object.getPrototypeOf(computed(() => 0)), ['computeValue_'], 'computed evaluation')
}
let runtime: ClientRuntime | undefined
let replica: ReturnType<typeof fixture.newReplica> | undefined
let rows: ReturnType<typeof createRowSource> | undefined
let locals: ReturnType<typeof createEngineLocals> | undefined
let pool: MobxPool | undefined
let seed: Parameters<MobxPool['apply']>[0]['rows'] | undefined
let subscriptions: (() => void)[] = [], visibleStop: (() => void) | undefined
let generation = 0, view: { id: string; title: string; stage: string }[] = []
const failures: string[] = []
const retired: WeakRef<object>[] = []
const root = createRoot(document.getElementById('root')!)
function readView() {
  return Array.from({ length: displayed }, (_, i) => {
    const id = `synthetic-${i}`
    const item = pool ? pool.issue(id) : runtime!.getSnapshot().issues.find(row => row.id === id)
    if (!item) throw new Error(`Missing visible row ${i}`)
    return { id, title: String(item.title), stage: String(item.stage) }
  })
}
function counts() {
  const models = pool ? Reflect.get(pool, 'models') as Record<string, Map<string, unknown>> : {}
  const summaries = pool?.residency ? Reflect.get(pool.residency, 'summaries') as Map<string, unknown> : undefined
  const relationSummaries = pool ? Reflect.get(pool.graph, 'summaries') as Map<string, Map<string, unknown>> : undefined
  return { history, resident, displayed, generation, arm,
    source: rows ? { ...rows.stats } : null,
    tables: pool ? Object.fromEntries(Object.entries(pool.tables).map(([k, v]) => [k, v.size])) : null,
    models: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, v.size])),
    coldIssues: pool?.residency?.ids('issue').length ?? 0,
    coldSessions: pool?.residency?.ids('session').length ?? 0,
    coldSummaries: summaries?.size ?? 0,
    relationSummaries: relationSummaries ? Object.fromEntries([...relationSummaries].map(([k, v]) => [k, v.size])) : null,
    readStates: pool?.readStates.size ?? 0,
    reactions: pool ? (Reflect.get(pool.worklist, 'stops') as Map<string, unknown>).size : 0,
    rendered: document.querySelectorAll('[data-measured-row]').length,
    failures: [...failures] }
}
const phases = ['replica', 'legacy', ...(arm === 'legacy' ? [] : ['source', 'pool shell', 'source snapshot', 'pool ingest', 'subscriptions']), 'visible read', 'first render']
async function phase(name: string) {
  times = {}
  const began = performance.now()
  switch (name) {
    case 'replica': replica = fixture.newReplica(); await replica.hydrate(); break
    case 'legacy':
      runtime = createClientRuntime({ principal: asClientPrincipal(asUserId(`build-${generation}`)),
        api: fixture.api, config: { httpOrigin: location.origin, wsClientUrl: 'ws://offline.invalid' },
        createReplicaFn: () => replica!, networkEnabled: false, onFatalError: error => failures.push(error),
        coarseClock: { now: () => fixedNow, subscribe: () => () => {} } })
      runtime.start()
      fixture.bindHub(runtime.hub); fixture.publishMachines()
      await runtime.getSnapshot().refreshRepos()
      break
    case 'source':
      rows = span('source summaries and joins', () => createRowSource(runtime!, runtime!.replica, { mode: 'overlaid' }))
      locals = createEngineLocals(runtime!); break
    case 'pool shell': pool = span('pool shell', () => new MobxPool(locals!.source.get(), undefined,
      { load: rows!.source.row!.bind(rows!.source), settings: arm === 'settings' })); break
    case 'source snapshot': seed = span('source snapshot', () => [
      ...rows!.source.snapshot('session'), ...rows!.source.snapshot('issue'), ...rows!.source.snapshot('worktree')]); break
    case 'pool ingest': pool!.apply({ type: 'replace', rows: seed! }); seed = undefined; break
    case 'subscriptions':
      subscriptions = [rows!.source.subscribe(event => pool!.apply(event)), locals!.source.subscribe(changed => pool!.applyLocals(locals!.source.get(), changed))]
      if (arm === 'settings') { pool!.attachPreferences(runtime!.ui); pool!.attachSettings(runtime!) }
      break
    case 'visible read': visibleStop = pool ? autorun(() => { view = readView() }) : undefined
      if (!pool) view = readView()
      break
    case 'first render': flushSync(() => root.render(<main>{view.map(row => <div key={row.id} data-measured-row={row.id}>{row.title} · {row.stage}</div>)}</main>)); break
    case 'settings demand':
      pool!.row('settingsCatalog', 'catalog'); pool!.row('settingsWindow', 'window'); pool!.row('preference', 'podium.sounds.enabled')
      await Promise.resolve(); break
    default: throw new Error(`Unknown phase ${name}`)
  }
  return { name, ms: performance.now() - began, times }
}
function dispose() {
  visibleStop?.(); visibleStop = undefined
  flushSync(() => root.render(null)); view = []
  subscriptions.splice(0).forEach(stop => stop())
  if (pool) retired.push(new WeakRef(pool))
  if (runtime) retired.push(new WeakRef(runtime))
  pool?.dispose(); locals?.dispose(); rows?.dispose(); runtime?.destroy()
  pool = undefined; rows = undefined; locals = undefined; runtime = undefined; replica = undefined; seed = undefined
  generation++
}
class Pod5133OwnerHolder {}
function owners() {
  const values: Record<string, object> = {}
  for (const [name, obj] of Object.entries({ pool, runtime, replica, source: rows?.source, locals: locals?.source, snapshot: runtime?.getSnapshot() })) {
    if (!obj) continue
    values[name] = obj
    for (const [key, value] of Object.entries(obj)) if (value && typeof value === 'object') values[`${name}.${key}`] = value
  }
  Object.assign(window, { __pod5133Owners: Object.assign(new Pod5133OwnerHolder(), values) })
}
const driver = {
  phases, phase, counts, dispose, owners,
  survivors: () => retired.filter(ref => ref.deref()).length,
  dropOwners: () => Reflect.deleteProperty(window, '__pod5133Owners'),
  ids: () => ({ issue: Array.from({ length: history + resident }, (_, i) => `synthetic-${i}`), session: Array.from({ length: history + resident }, (_, i) => `synthetic-session-${i}`) }),
  async all() { const began = performance.now(); const result = []; for (const name of phases) result.push(await phase(name)); return { ms: performance.now() - began, phases: result } },
}
Object.assign(window, { __buildCost: driver })
declare global { interface Window { __buildCost: typeof driver } }
