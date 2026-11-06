/**
 * THE HOST SURFACE (POD-314) — `memoryBreakdown` and `reclaimInventory`, from the
 * contract table.
 *
 * ON THE PLAIN COMMAND PATH (ADR 12 D8, POD-6419). Both ask a daemon about its
 * machine (a /proc walk, a disk estimate) and write nothing: ADR 12 D1 places
 * the memory breakdown among the request answers. So they take the plain path:
 * the front door (exposure, role floor, then the parse) and a plain handler that
 * cannot write synced data. These routes are their real doors, not adapters.
 *
 * NO QUERIES. The empty query table is written out rather than omitted so that
 * "this family has no reads" and "someone forgot the reads" cannot look alike —
 * the same reason `SERVED_NOWHERE` exists at L1.
 */

import type { FamilyProcedures } from '../derived-family'
import { plainFamilyProcedures } from '../plain-command/family'
import { HOST_COMMANDS_TRPC } from './registry'

const HOST_QUERIES = {} as const

export type HostProcedures = FamilyProcedures<typeof HOST_COMMANDS_TRPC, typeof HOST_QUERIES>

/** The two host procedures, spread into `router.ts`'s `hosts` router. */
export const hostFamilyProcedures = (): HostProcedures =>
  plainFamilyProcedures({
    family: 'hosts',
    service: (state) => ({
      hosts: state.modules.hosts,
      rpc: state.modules.rpc,
      issues: state.modules.issues,
      repos: state.repos,
    }),
    commands: HOST_COMMANDS_TRPC,
    queries: HOST_QUERIES,
  })
