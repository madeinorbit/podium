import { type IdbFactoryLike, IndexedDbSyncStore } from '@podium/sync/adapters/indexeddb'

/**
 * Open the durable entity store used by the Expo web runtime.
 *
 * This platform file is a bundle boundary: the browser must not carry the
 * native SQLite bridge or its WASM asset when IndexedDB is the chosen engine.
 */
export function openMobileEntityStore(databaseName: string, onDegraded: (cause: string) => void) {
  return IndexedDbSyncStore.open({
    factory: globalThis.indexedDB as unknown as IdbFactoryLike,
    databaseName,
    onDegraded: (degradation) => onDegraded(String(degradation.cause)),
  })
}
