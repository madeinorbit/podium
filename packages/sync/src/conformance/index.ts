/**
 * The cross-hop conformance suite (POD-373), exported from the package.
 *
 * A later hop's test file is three lines:
 *
 *     import { describeSyncConformance } from '@podium/sync'
 *     import { indexedDbInstantiation } from './conformance-instantiation'
 *     describeSyncConformance(indexedDbInstantiation)
 *
 * POD-307, POD-308, POD-309, POD-374 and POD-375 plug in that way and edit nothing
 * here. Everything a hop supplies is in `instantiation.ts`; everything the suite
 * asserts is in `suite.ts`; the Phase-2 gate conditions are data in `gates.ts` with
 * a totality test over them.
 */
export * from './authority'
export * from './gates'
export * from './harness'
export * from './in-memory'
export * from './instantiation'
export * from './suite'
