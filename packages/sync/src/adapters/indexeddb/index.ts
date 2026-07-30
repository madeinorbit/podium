/**
 * The WEB replica storage adapter (POD-374) as a BROWSER ENTRYPOINT of
 * `@podium/sync` — `@podium/sync/adapters/indexeddb` (POD-307).
 *
 * The package barrel already re-exports these three modules, but a browser-safe
 * workspace may not import the barrel: it value-exports the Authority, the Ledger
 * and the SQLite repository, so bundling it would inline Node code. This file is
 * the specifier apps/web imports instead, and rule 12b in
 * scripts/check-boundaries.ts holds its TRANSITIVE closure to no-Node — which is
 * what `packages/sync`'s `neutral` tag rests on.
 *
 * `./conformance` and `./test-support` are deliberately NOT here, for the reason
 * the package barrel already gives: the first pulls in the conformance
 * instantiation and the second imports `fake-indexeddb`, and neither belongs in a
 * shipped browser bundle.
 */
export * from './idb'
export * from './schema'
export * from './store'
