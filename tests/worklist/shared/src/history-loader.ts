/**
 * History kept OFF the device, behind the one loader (POD-7114, design
 * POD-7059 "Memory, cache and leaving", "Lookup").
 *
 * Since POD-7094 every row the device holds is in the pool, so a fixture can
 * no longer grow "history" by putting rows in the pool and expect them to be
 * cold. This port stands in for `@podium/sync`'s `CollectionLoader` over a
 * server that holds the history: a lookup of a record the device does not
 * hold asks for its "one record" instance here, and `answer()` lands the
 * asked records in the pool through the feed (`pool.apply`), the way the
 * real loader's fetch reaches it. A record the history does not hold is
 * answered complete without it, so the lookup settles as not visible.
 */
import { LOADER_KIND, type LoaderEntity } from '@podium/client-graph/collections'
import type { MobxPool } from '@podium/client-graph/pool'
import type {
  CollectionLoaderPort,
  LoaderInstance,
  RowRecord,
} from '@podium/client-graph/shared/source'

const ENTITY_OF_KIND = Object.fromEntries(
  Object.entries(LOADER_KIND).map(([entity, kind]) => [kind, entity as LoaderEntity]),
) as Record<string, LoaderEntity>

const keyOf = (spec: LoaderInstance) => `${spec.collection}:${JSON.stringify(spec.args ?? {})}`

export interface HistoryLoader {
  readonly port: CollectionLoaderPort
  /** Every record the device asked for, in order, as `[entity, id]`. */
  readonly asked: Array<readonly [LoaderEntity, string]>
  /**
   * The server's answer to every pending request: the asked records the
   * history holds land in the pool in ONE feed update; the rest settle as
   * not visible. Returns how many records landed.
   */
  answer(pool: MobxPool): number
  /** Replace a history record (or drop it with `undefined`). */
  put(entity: LoaderEntity, id: string, value: RowRecord['value']): void
}

const STUB_FIELDS = [
  'id',
  'repoId',
  'seq',
  'stage',
  'closedReason',
  'archived',
  'deletedAt',
  'isDraftVessel',
  'audience',
  'parentId',
] as const

/**
 * A loader over `history` rows: issues and sessions the device does not
 * hold. `stubs` are the issues the device holds as stubs (reference, state,
 * parent), the way the policy's stub collection leaves all history.
 */
export function historyLoader(
  history: readonly RowRecord[],
  stubs: readonly Readonly<Record<string, unknown>>[] = [],
): HistoryLoader {
  const stubTable = new Map(
    stubs.map((value) => [
      String(value.id),
      Object.fromEntries(
        STUB_FIELDS.filter((field) => value[field] !== undefined).map((field) => [
          field,
          value[field],
        ]),
      ),
    ]),
  )
  const stubRows = [...stubTable].map(([id, stub]) => ({ id, stub }))
  const byParent = new Map<string, string[]>()
  for (const [id, stub] of stubTable)
    if (typeof stub.parentId === 'string')
      byParent.set(stub.parentId, [...(byParent.get(stub.parentId) ?? []), id])
  const server = new Map<string, RowRecord['value']>()
  for (const row of history) server.set(`${row.kind}:${row.id}`, row.value)
  const complete = new Set<string>()
  const pending = new Map<string, readonly [LoaderEntity, string]>()
  const listeners = new Set<(change: 'markers' | 'stubs' | 'connection') => void>()
  const asked: Array<readonly [LoaderEntity, string]> = []

  const ask = (entity: LoaderEntity | undefined, id: unknown, key: string) => {
    if (entity === undefined || typeof id !== 'string' || complete.has(key) || pending.has(key))
      return
    pending.set(key, [entity, id])
    asked.push([entity, id])
  }
  const port: CollectionLoaderPort = {
    request(specs) {
      for (const spec of specs) {
        if (!spec.collection.endsWith('.one')) continue
        const kind = spec.collection.slice(0, -'.one'.length)
        ask(ENTITY_OF_KIND[kind], spec.args?.id, keyOf(spec))
      }
    },
    // As the loader's: a view's hold loads its instance first (search hits, POD-7158).
    show(spec) {
      port.request([spec])
      return () => {}
    },
    status: (spec) => (complete.has(keyOf(spec)) ? 'complete' : 'loading'),
    online: true,
    firstDownload: false,
    isComplete: (spec) => (complete.has(keyOf(spec)) ? {} : undefined),
    wasRefused: () => false,
    stubOf: (kind, id) => (kind === LOADER_KIND.issue ? stubTable.get(id) : undefined),
    stubsByParent: (parentId) => byParent.get(parentId) ?? [],
    stubRows: (kind) => (kind === LOADER_KIND.issue ? stubRows : []),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    port,
    asked,
    put(entity, id, value) {
      server.set(`${entity}:${id}`, value)
    },
    answer(pool) {
      const rows: RowRecord[] = []
      for (const [key, [entity, id]] of pending) {
        complete.add(key)
        const value = server.get(`${entity}:${id}`)
        if (value !== undefined) rows.push({ kind: entity, id, value })
      }
      pending.clear()
      if (rows.length > 0) pool.apply({ type: 'update', rows })
      for (const listener of listeners) listener('markers')
      return rows.length
    },
  }
}
