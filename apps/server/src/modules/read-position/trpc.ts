/**
 * Feed-cursor tRPC surface (POD-1380) — `readPosition.advance`.
 *
 * The write, `advance`, is on the sync write entry point (`sync-write.ts`,
 * POD-6412), which applies the contract-derived LIVE gate as its target check;
 * the route below is only a thin adapter onto it.
 *
 * There is no read route (POD-6673): a device holds its read positions in its
 * replica, from the synced `userReadPosition` kind, delivered to its owner only.
 */

import { legacyRouteAdapters } from '../sync-write/family'
import { READ_POSITION_SYNC_FAMILY } from './sync-write'

/** Feed-cursor procedures for the root router under the `readPosition` namespace. */
export function readPositionFamilyProcedures() {
  return {
    // LEGACY(remove-after: 2027-03): the shipped mobile app advances through this
    // route. Removing it leaves that app's read positions unsaved on this server.
    ...legacyRouteAdapters(READ_POSITION_SYNC_FAMILY, ['advance']),
  }
}
