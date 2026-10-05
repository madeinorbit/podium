import type { MobxPool } from './pool'
import { isMachineOfflineForLiveTerminal } from '@podium/model/browser'
import { compareStructural, computed, observable, runInAction } from 'mobx'
import { debugName } from './debug-name'
import { createHeaderRepositoryRelations } from './header-repositories'
import { RelationBuckets } from './relations'
import {
  HEADER_RELATIONS,
  HEADER_SCHEMA,
  type HeaderEntity,
  type HeaderRecord,
  type HeaderRows,
  type ShippingCounts,
} from './header-schema'
import { createKeyedAnswer } from './query-result'

const EMPTY_SHIPPING: ShippingCounts = { unfinishedCount: 0, decisionCount: 0 }
interface OfflineMachine {
  id: string
  order: string
  expires: number
}

/** Storage and metadata-driven edges owned by MobxPool, never a second runtime
 * or feed. Product reads call pool.row; get is the pool reader's storage seam. */
export function createHeaderEntities() {
  // Approved applying-action indexes (POD-5542): these reverse lookups and
  // scalar totals avoid rebuilding all rows for each header question.
  const repositories = createHeaderRepositoryRelations()
  const tables = Object.fromEntries(
    Object.keys(HEADER_SCHEMA).map((entity) => [
      entity,
      observable.map<string, object>(undefined, {
        deep: false,
        name: debugName(() => `pool.${entity}`),
      }),
    ]),
  ) as Record<HeaderEntity, ReturnType<typeof observable.map<string, object>>>
  const orders = observable.map<HeaderEntity, readonly string[]>(undefined, { deep: false })
  const relations = new RelationBuckets({ trackedForward: true })
  const sessionIds = observable.map<string, true>(undefined, { deep: false })
  const shipping = observable.map<string, ShippingCounts>(undefined, { deep: false })
  const idleCapUnmet = observable.box(0)
  const repositoryPathsRevision = observable.box(0)
  // Scalar source membership, including expired candidates. Window reads skip
  // history through subtree deadline bounds and never open historical rows.
  const offline = observable.map<string, OfflineMachine>(undefined, { deep: false })
  let offlineOrder = createKeyedAnswer<OfflineMachine>(undefined, (value) => -value.expires)
  let offlineTime = createKeyedAnswer<OfflineMachine>((a, b) => a.expires - b.expires)
  const offlineRevision = observable.box(0)
  const offlineListeners = new Set<(id: string | undefined) => void>()
  const machineArrival = new Map<string, number>()
  let machineSequence = 0
  let machineOrder = new Map<string, number>()

  function refreshOffline(id: string): boolean {
    const machine = tables.machine.get(id) as HeaderRows['machine'] | undefined
    const seen = machine && Date.parse(machine.lastSeenAt)
    const eligible =
      machine &&
      isMachineOfflineForLiveTerminal(machine) &&
      !machine.revokedAt &&
      !machine.supersededBy &&
      machine.serviceAssignment?.agentExecution !== false &&
      !relations.many(`machine:${id}:metrics`).length &&
      Number.isFinite(seen)
    const explicit = machineOrder.get(id)
    const order =
      explicit === undefined
        ? `1:${String(machineArrival.get(id)).padStart(16, '0')}`
        : `0:${String(explicit).padStart(16, '0')}`
    const next = eligible ? { id, order, expires: seen! + 7 * 86_400_000 } : undefined
    if (compareStructural(offline.get(id), next)) return false
    if (next) {
      offline.set(id, next)
      offlineOrder.set(id, order, next)
      offlineTime.set(id, '', next)
    } else {
      offline.delete(id)
      offlineOrder.delete(id)
      offlineTime.delete(id)
    }
    return true
  }
  function flushOffline(ids: Iterable<string>): void {
    const changed: string[] = []
    for (const id of ids) if (refreshOffline(id)) changed.push(id)
    if (!changed.length) return
    offlineRevision.set(offlineRevision.get() + 1)
    for (const id of changed) for (const listener of offlineListeners) listener(id)
  }
  // Kernel facade rows use ascending canonical IDs. Membership changes alone
  // invalidate this order; per-session activity never sorts the whole fleet.
  const sessionOrder = computed(() => [...sessionIds.keys()].sort(), { equals: compareStructural })
  // Borrow the last successful API response for opt-in differential checks.
  // Same objects as the rows, no second fetch, replica or mutation owner.
  const received: {
    quotas: HeaderRows['quota'][]
    history?: HeaderRows['history']
    lifecycle?: HeaderRows['lifecycle']
  } = { quotas: [] }

  function shippingContribution(value: object | undefined) {
    const order = value as HeaderRows['shipOrder'] | undefined
    if (!order?.repoId) return undefined
    const counts = HEADER_SCHEMA.shipOrder.counts
    return {
      repoId: order.repoId,
      unfinishedCount: (counts.unfinished as readonly string[]).includes(order.humanState) ? 1 : 0,
      decisionCount: order.humanState === counts.decision ? 1 : 0,
    }
  }
  function adjustShipping(value: ReturnType<typeof shippingContribution>, delta: 1 | -1): void {
    if (!value || (!value.unfinishedCount && !value.decisionCount)) return
    const previous = shipping.get(value.repoId) ?? EMPTY_SHIPPING
    const next = {
      unfinishedCount: previous.unfinishedCount + delta * value.unfinishedCount,
      decisionCount: previous.decisionCount + delta * value.decisionCount,
    }
    if (next.unfinishedCount || next.decisionCount) shipping.set(value.repoId, next)
    else shipping.delete(value.repoId)
  }

  function change(entity: string, id: string, next: object | undefined): void {
    if (entity === 'session') {
      if (next) sessionIds.set(id, true)
      else sessionIds.delete(id)
    }
    for (const relation of HEADER_RELATIONS) {
      if (relation.from !== entity) continue
      const address = `${entity}:${id}:${relation.name}`
      const target = next && (next as Record<string, unknown>)[relation.key]
      const current = typeof target === 'string' && target ? [target] : []
      relations.move(address, id, current, target => `${relation.to}:${target}:${relation.inverse}`)
    }
  }

  return {
    tables,
    received,
    orders,
    order(entity: HeaderEntity, ids: readonly string[]): void {
      if (!compareStructural(orders.get(entity), ids)) {
        if (entity === 'repository') repositories.order(ids)
        if (entity === 'machine') {
          const changed = new Set(machineOrder.keys())
          machineOrder = new Map()
          for (const id of ids) {
            if (!machineOrder.has(id)) machineOrder.set(id, machineOrder.size)
            changed.add(id)
          }
          flushOffline(changed)
        }
        orders.set(entity, ids)
      }
    },
    sessionIds,
    sessionOrder,
    count: (entity: HeaderEntity) => tables[entity].size,
    firstId: (entity: HeaderEntity): string | undefined =>
      orders.get(entity)?.[0] ?? tables[entity].keys().next().value,
    get: (entity: HeaderEntity, id: string) => tables[entity].get(id),
    one: (entity: string, id: string, relation: string) => relations.one(`${entity}:${id}:${relation}`),
    members: (entity: string, id: string, relation: string) =>
      relations.many(`${entity}:${id}:${relation}`),
    shippingCounts: (repoId: string | null) => (repoId && shipping.get(repoId)) || EMPTY_SHIPPING,
    idleCapUnmetCount: () => idleCapUnmet.get(),
    repositoryPathsRevision: () => repositoryPathsRevision.get(),
    repositoryGroup: (path: string) => repositories.group(path),
    shippingScope: (cwd: string, machineId?: string) => repositories.shippingScope(cwd, machineId),
    offlineMachineIds: function* (now: number): Generator<string> {
      let value = offlineOrder.firstBounded(-now, 'atMost')
      while (value) {
        yield value.id
        value = offlineOrder.firstBounded(-now, 'atMost', value, value.id)
      }
    },
    hasOfflineMachine: (id: string, now: number) => (offline.get(id)?.expires ?? -Infinity) >= now,
    offlineMachineOrder: (id: string) => offline.get(id)?.order ?? id,
    offlineMachineBoundaries(now: number) {
      offlineRevision.get()
      const pivot: OfflineMachine = { id: '', order: '', expires: now }
      return {
        previous: offlineTime.before(pivot, '')?.expires,
        next: offlineTime.after(pivot, '')?.expires,
      }
    },
    crossedOfflineMachineIds: function* (from: number, to: number): Generator<string> {
      const low = Math.min(from, to),
        high = Math.max(from, to)
      const pivot: OfflineMachine = { id: '', order: '', expires: low }
      let value = offlineTime.after(pivot, '')
      while (value && value.expires < high) {
        yield value.id
        value = offlineTime.after(value, value.id)
      }
    },
    subscribeOfflineMachines(listener: (id: string | undefined) => void): () => void {
      offlineListeners.add(listener)
      return () => {
        offlineListeners.delete(listener)
      }
    },
    change,
    apply(records: readonly HeaderRecord[]): void {
      runInAction(() => {
        // Net contributions preserve the old sorted path multiset's equality
        // without materializing it. Only paths in changed rows enter this batch.
        const pathChanges = new Map<string, number>()
        const offlineChanges = new Set<string>()
        const adjustPath = (path: string | undefined, delta: 1 | -1) => {
          if (path !== undefined) pathChanges.set(path, (pathChanges.get(path) ?? 0) + delta)
        }
        for (const record of records) {
          const table = tables[record.kind]
          const previous = table.get(record.id)
          if (compareStructural(previous, record.value)) continue
          if (record.kind === 'machine') {
            if (record.value && !machineArrival.has(record.id))
              machineArrival.set(record.id, machineSequence++)
            else if (!record.value) machineArrival.delete(record.id)
            offlineChanges.add(record.id)
          }
          if (record.kind === 'shipOrder') {
            const before = shippingContribution(previous),
              after = shippingContribution(record.value)
            if (!compareStructural(before, after)) {
              adjustShipping(before, -1)
              adjustShipping(after, 1)
            }
          }
          if (record.kind === 'hostMetric') {
            const beforeMachine = (previous as HeaderRows['hostMetric'] | undefined)?.machineId
            const afterMachine = (record.value as HeaderRows['hostMetric'] | undefined)?.machineId
            if (beforeMachine) offlineChanges.add(beforeMachine)
            if (afterMachine) offlineChanges.add(afterMachine)
            const key = HEADER_SCHEMA.hostMetric.counts.idleCapUnmet
            const before = (previous as HeaderRows['hostMetric'] | undefined)?.[key] ?? 0
            const after = (record.value as HeaderRows['hostMetric'] | undefined)?.[key] ?? 0
            if (before !== after) idleCapUnmet.set(idleCapUnmet.get() + after - before)
          }
          if (record.kind === 'repository') {
            repositories.set(record.id, record.value as HeaderRows['repository'] | undefined)
            const key = HEADER_SCHEMA.repository.revisionFields.paths
            const before = (previous as HeaderRows['repository'] | undefined)?.[key]
            const after = (record.value as HeaderRows['repository'] | undefined)?.[key]
            if (before !== after) {
              adjustPath(before, -1)
              adjustPath(after, 1)
            }
          }
          if (record.value === undefined) table.delete(record.id)
          else table.set(record.id, record.value)
          change(record.kind, record.id, record.value)
        }
        repositories.flush()
        flushOffline(offlineChanges)
        for (const delta of pathChanges.values()) {
          if (delta === 0) continue
          repositoryPathsRevision.set(repositoryPathsRevision.get() + 1)
          break
        }
      })
    },
    clear(): void {
      if (tables.repository.size) repositoryPathsRevision.set(repositoryPathsRevision.get() + 1)
      for (const table of Object.values(tables)) table.clear()
      relations.clear()
      orders.clear()
      sessionIds.clear()
      shipping.clear()
      idleCapUnmet.set(0)
      repositories.clear()
      offline.clear()
      offlineOrder = createKeyedAnswer<OfflineMachine>(undefined, (value) => -value.expires)
      offlineTime = createKeyedAnswer<OfflineMachine>((a, b) => a.expires - b.expires)
      machineArrival.clear()
      machineOrder.clear()
      machineSequence = 0
      offlineRevision.set(offlineRevision.get() + 1)
      for (const listener of [...offlineListeners]) listener(undefined)
    },
  }
}

/** The screen registry owns creation and teardown of this view. */
export function headerEntities(pool: MobxPool) {
  return pool.sources.view('header.entities', () => {
    const view = createHeaderEntities()
    return Object.assign(view, { dispose: () => view.clear() })
  })
}
