/**
 * THE DERIVED PERF SURFACE (POD-314) — `report` and `reset` from the contract
 * table, `snapshot` from the query table. Always on; the two commands are
 * diagnostics [POD-701].
 */

import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import { PERF_COMMANDS_TRPC } from './commands'
import { PERF_QUERIES } from './queries'

export type PerfProcedures = FamilyProcedures<typeof PERF_COMMANDS_TRPC, typeof PERF_QUERIES>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `perf` router. */
export const perfFamilyProcedures = (): PerfProcedures =>
  derivedFamilyProcedures({
    family: 'perf',
    service: (state) => state.modules.perf,
    commands: PERF_COMMANDS_TRPC,
    queries: PERF_QUERIES,
  })
