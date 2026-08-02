/**
 * THE DERIVED PERF SURFACE (POD-314) — `report` and `reset` from the contract
 * table, `snapshot` from the query table. Always on; the two commands are
 * diagnostics [POD-701].
 *
 * The selector returns the registry AND the transport-derived feed principal
 * (POD-1230). Report partitions client switch traces by that principal — never
 * by a field of the trace body.
 */

import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import { PERF_COMMANDS_TRPC } from './commands'
import { PERF_QUERIES } from './queries'

export type PerfProcedures = FamilyProcedures<typeof PERF_COMMANDS_TRPC, typeof PERF_QUERIES>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `perf` router. */
export const perfFamilyProcedures = (): PerfProcedures =>
  derivedFamilyProcedures({
    family: 'perf',
    service: (state) => ({
      perf: state.modules.perf,
      feedPrincipal: state.feedPrincipal,
    }),
    commands: PERF_COMMANDS_TRPC,
    queries: PERF_QUERIES,
  })
