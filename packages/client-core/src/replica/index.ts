export * from './async-storage'
/**
 * The wire-v2 feed consumer and the kernel-backed facade join the barrel
 * (POD-1223): `apps/web` composes the whole assembly and must reach all of it
 * through the one `@podium/client-core/replica` specifier the app already
 * imports. Both are type-thin and pull in no storage engine — the IndexedDB
 * adapter arrives from `@podium/sync/adapters/indexeddb` at the composition
 * root, not from here.
 */
export * from './feed'
export * from './kernel'
export * from './replica'
