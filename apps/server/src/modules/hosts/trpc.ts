/**
 * THE DERIVED HOST SURFACE (POD-314) — `memoryBreakdown` from the contract table.
 *
 * NO QUERIES. The `hosts` router serves exactly one procedure, and the empty
 * query table is written out rather than omitted so that "this family has no
 * reads" and "someone forgot the reads" cannot look alike — the same reason
 * `SERVED_NOWHERE` exists at L1.
 */

import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import { HOST_COMMANDS_TRPC } from './registry'

const HOST_QUERIES = {} as const

export type HostProcedures = FamilyProcedures<typeof HOST_COMMANDS_TRPC, typeof HOST_QUERIES>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `hosts` router. */
export const hostFamilyProcedures = (): HostProcedures =>
  derivedFamilyProcedures({
    family: 'hosts',
    service: (state) => ({
      hosts: state.modules.hosts,
      rpc: state.modules.rpc,
      repos: state.repos,
    }),
    commands: HOST_COMMANDS_TRPC,
    queries: HOST_QUERIES,
  })
