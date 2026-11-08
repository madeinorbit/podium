/**
 * THE SUPERAGENT'S WRITE ROUTES (POD-383; on the sync write entry point since
 * POD-6419).
 *
 * The eight thread commands run through `sync.submit` (`sync-write.ts`). Their
 * per-command routes stay, as thin adapters onto it, because shipped clients call
 * every one of them: the mobile app (`sendTurn`, `interruptTurn`,
 * `ensureSession`, `clear`) and the desktop app's bundled web (all eight;
 * `startBtw` from v0.1.3's "Ask superagent (BTW)" button).
 *
 * `router.ts` spreads these into the `superagent` router beside its reads
 * (`listThreads`, `history`, `latestTurnFailure`), which carry no contract: a
 * `visibility` class describes what a command WRITES. `superagent.send`, the
 * deleted alias of `sendTurn`, stays deleted (POD-383).
 *
 * OUTPUT TYPES SURVIVE: each route's output is the joined handler's return type
 * (`MutationProcedures`), so `trpc.superagent.sendTurn.mutate(…)` stays checked
 * in the apps.
 */

import type { MutationProcedures } from '../derived-family'
import { legacyRouteAdapters } from '../sync-write/family'
import type { SUPERAGENT_COMMANDS } from './registry'
import { SUPERAGENT_SYNC_FAMILY } from './sync-write'

export type SuperagentProcedures = MutationProcedures<typeof SUPERAGENT_COMMANDS>

/**
 * LEGACY(remove-after: 2027-03): every superagent write route, as an adapter onto
 * `sync.submit`. Removing one breaks that write in the shipped mobile app or an
 * older desktop app's bundled web against this server.
 */
export function superagentFamilyProcedures(): SuperagentProcedures {
  return legacyRouteAdapters(SUPERAGENT_SYNC_FAMILY, [
    'sendTurn',
    'interruptTurn',
    'openInTerminal',
    'clear',
    'restart',
    'ensureSession',
    'startBtw',
    'concierge',
  ])
}
