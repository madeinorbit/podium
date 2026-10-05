import { compareStructural, computed, observable, runInAction } from 'mobx'
import { debugName } from './debug-name'
import { createHeaderRepositoryRelations } from './header-repositories'
import {
  HEADER_RELATIONS,
  HEADER_SCHEMA,
  type HeaderEntity,
  type HeaderRecord,
  type HeaderRows,
  type ShippingCounts,
} from './header-schema'

const EMPTY_SHIPPING: ShippingCounts = { unfinishedCount: 0, decisionCount: 0 }

/** Storage and metadata-driven edges owned by MobxPool, never a second runtime
 * or feed. Product reads call pool.row; get is the pool reader's storage seam. */
export function createHeaderEntities() {
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
  const members = observable.map<string, readonly string[]>(undefined, { deep: false })
  const refs = observable.map<string, string>(undefined, { deep: false })
  const sessionIds = observable.map<string, true>(undefined, { deep: false })
  const shipping = observable.map<string, ShippingCounts>(undefined, { deep: false })
  const idleCapUnmet = observable.box(0)
  const repositoryPathsRevision = observable.box(0)
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
      const previous = refs.get(address)
      const target = next && (next as Record<string, unknown>)[relation.key]
      const current = typeof target === 'string' && target ? target : undefined
      if (previous === current) continue
      if (previous) {
        const key = `${relation.to}:${previous}:${relation.inverse}`
        const remaining = (members.get(key) ?? []).filter((member) => member !== id)
        if (remaining.length) members.set(key, remaining)
        else members.delete(key)
      }
      if (current) {
        const key = `${relation.to}:${current}:${relation.inverse}`
        members.set(key, [...(members.get(key) ?? []), id])
        refs.set(address, current)
      } else refs.delete(address)
    }
  }

  return {
    tables,
    received,
    orders,
    order(entity: HeaderEntity, ids: readonly string[]): void {
      if (!compareStructural(orders.get(entity), ids)) {
        if (entity === 'repository') repositories.order(ids)
        orders.set(entity, ids)
      }
    },
    sessionIds,
    sessionOrder,
    count: (entity: HeaderEntity) => tables[entity].size,
    firstId: (entity: HeaderEntity): string | undefined =>
      orders.get(entity)?.[0] ?? tables[entity].keys().next().value,
    get: (entity: HeaderEntity, id: string) => tables[entity].get(id),
    one: (entity: string, id: string, relation: string) => refs.get(`${entity}:${id}:${relation}`),
    members: (entity: string, id: string, relation: string) =>
      members.get(`${entity}:${id}:${relation}`) ?? [],
    shippingCounts: (repoId: string | null) => (repoId && shipping.get(repoId)) || EMPTY_SHIPPING,
    idleCapUnmetCount: () => idleCapUnmet.get(),
    repositoryPathsRevision: () => repositoryPathsRevision.get(),
    repositoryGroup: (path: string) => repositories.group(path),
    change,
    apply(records: readonly HeaderRecord[]): void {
      runInAction(() => {
        // Net contributions preserve the old sorted path multiset's equality
        // without materializing it. Only paths in changed rows enter this batch.
        const pathChanges = new Map<string, number>()
        const adjustPath = (path: string | undefined, delta: 1 | -1) => {
          if (path !== undefined) pathChanges.set(path, (pathChanges.get(path) ?? 0) + delta)
        }
        for (const record of records) {
          const table = tables[record.kind]
          const previous = table.get(record.id)
          if (compareStructural(previous, record.value)) continue
          if (record.kind === 'shipOrder') {
            const before = shippingContribution(previous),
              after = shippingContribution(record.value)
            if (!compareStructural(before, after)) {
              adjustShipping(before, -1)
              adjustShipping(after, 1)
            }
          }
          if (record.kind === 'hostMetric') {
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
      members.clear()
      orders.clear()
      refs.clear()
      sessionIds.clear()
      shipping.clear()
      idleCapUnmet.set(0)
      repositories.clear()
    },
  }
}
