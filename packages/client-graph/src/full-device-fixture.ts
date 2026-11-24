import type { MobxPool } from './pool'

/**
 * Declare that a synthetic fixture supplies every row, including empty
 * collections. Only layout/interaction and resident-data fixtures may make
 * this promise. Tests of collection loading or on-demand content use the
 * empty-device harness instead.
 */
export function fullDevice<T extends MobxPool>(pool: T): T {
  if (pool.collections.available) throw new Error('fullDevice requires a fixture without a loader')
  // Keep the resident-row fixture route: a fake loader would make parity
  // tests compare the device-store implementation with itself.
  pool.collections.attach(() => undefined, 'full-device')
  return pool
}
