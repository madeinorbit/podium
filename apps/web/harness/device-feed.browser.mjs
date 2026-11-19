/** Isolated real sync engine and IndexedDB, excluding view/model work which
 * cannot move to a sync worker. The same fixture runs over each arm's code. */
import { IndexedDbSyncStore } from '../../../packages/sync/src/adapters/indexeddb/store'
import { Replica } from '../../../packages/sync/src/replica/replica'

window.measureDeviceFeed = async ({ rows, policy, instances, now, updateIds }) => {
  const store = await IndexedDbSyncStore.open({ factory: indexedDB, keyRange: IDBKeyRange, onDegraded: e => { throw Error(JSON.stringify(e)) } })
  const cache = store.viewFor('operator').cache
  const cursor = { feedId: 'measurement', epoch: 'one', seq: 1 }
  cache.applyAtomic({
    operations: rows.map(row => ({ kind: 'upsert', entity: row.entity, entityId: row.entityId, value: row.value,
      provenance: { seq: 1 }, ...(row.part === 'stub' ? { part: 'stub' } : {}) })),
    ...(policy ? { policy, instances } : {}), cursor,
  })
  await store.settled()
  const replica = new Replica({ store: cache, authority: { changesRange: async (at, _signal, target) => {
    target?.(at, {})
    // An explicit empty iterator avoids the bundler eliding an immediately
    // invoked empty async generator to `undefined` in the measurement build.
    return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }
  } },
    now: () => now, request: () => {}, onEvent: () => {} })
  replica.connect()
  await replica.settled()
  const updates = updateIds.map(id => cache.read('issueProjection', id))
  if (updates.length !== 100 || updates.some(row => !row)) throw Error('The common feed targets must all be resident')
  const text = JSON.stringify({ kind: 'delta', ...cursor, fromSeq: 1, seq: 101, minAvailableSeq: 0,
    changes: updates.map((row, index) => ({ entity: row.entity, entityId: row.entityId, op: 'upsert', seq: index + 2,
      payload: { ...row.value, title: row.value.title + ' measured' } })) })
  window.runDeviceFeed = async () => {
  let submitMs = 0, submitCalls = 0
  const originals = new Map()
  for (const name of ['put', 'delete', 'clear']) {
    const original = IDBObjectStore.prototype[name]
    originals.set(name, original)
    IDBObjectStore.prototype[name] = function (...args) {
      const start = performance.now()
      try { return original.apply(this, args) }
      finally { submitMs += performance.now() - start; submitCalls++ }
    }
  }
  try {
    const parseStart = performance.now(), frame = JSON.parse(text), parseMs = performance.now() - parseStart
    const receiveStart = performance.now()
    await replica.receive(frame)
    const receiveMs = performance.now() - receiveStart, durableStart = performance.now()
    await store.settled()
    const durableWaitMs = performance.now() - durableStart
    if (cache.readCursor()?.seq !== 101 || updates.length !== 100) throw Error('Feed did not apply 100 changes')
    for (const row of updates)
      if (!cache.read(row.entity, row.entityId)?.value.title.endsWith(' measured')) throw Error('Feed value missing')
    return { parseMs, receiveMs, durableWaitMs, storageMainThreadSubmitMs: submitMs, submitCalls, rows: cache.readEntities().length, changes: updates.length }
  } finally {
    for (const [name, original] of originals) IDBObjectStore.prototype[name] = original
    replica.disconnect()
    store.close()
  }
  }
  return { setupRows: cache.readEntities().length }
}
