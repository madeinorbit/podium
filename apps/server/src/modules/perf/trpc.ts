/**
 * THE DERIVED PERF SURFACE (POD-314) — `report` and `reset` from the contract
 * table, `snapshot` from the query table. Always on; the two commands are
 * diagnostics [POD-701].
 *
 * The selector returns the registry AND the transport-derived feed principal
 * (POD-1230). Report partitions client switch traces by that principal — never
 * by a field of the trace body.
 */

import type { FamilyProcedures } from '../derived-family'
import { plainFamilyProcedures } from '../plain-command/family'
import type { PERF_COMMANDS_TRPC } from './commands'
import { PERF_PLAIN_FAMILY } from './plain-family'
import { PERF_QUERIES } from './queries'

export type PerfProcedures = FamilyProcedures<typeof PERF_COMMANDS_TRPC, typeof PERF_QUERIES>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `perf` router. */
export const perfFamilyProcedures = (): PerfProcedures =>
  plainFamilyProcedures(PERF_PLAIN_FAMILY, PERF_QUERIES)
