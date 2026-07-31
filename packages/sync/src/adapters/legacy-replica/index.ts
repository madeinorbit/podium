/**
 * ADR 6 D6's legacy replica migration, as a BROWSER ENTRYPOINT of @podium/sync
 * (`@podium/sync/adapters/legacy-replica`).
 *
 * An adapter rather than kernel code because it names a storage technology's
 * layout — the localStorage/AsyncStorage key space the old TanStack replica
 * wrote. It names no DOM global: the caller injects the key-value source, which
 * is what lets ONE module serve both the web's `localStorage` and mobile's
 * hydrated AsyncStorage bridge.
 */
export * from './adoption'
export * from './import'
export * from './keys'
