/**
 * Re-export of the shared poll cadence (POD-4520): `createSharedStatTick`
 * and `scheduleStatPoll` live in `../transcript-types.js` beside their types
 * — the mechanism-free leaf both the Store and the adapters may import —
 * so adapter observers can run on the shared tick without reaching into the
 * Store. Every existing importer of this module keeps working unchanged.
 */
export {
  createSharedStatTick,
  scheduleStatPoll,
} from '../transcript-types.js'
export type { SharedStatTick, StatTick } from '../transcript-types.js'
