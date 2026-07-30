/**
 * THE DERIVED FILE SURFACE (POD-314) — `write` from the contract table, `read`
 * and `list` from the query table.
 *
 * The selector returns the three things this family reaches (see `registry.ts`),
 * so the widening past a single service is visible in the family rather than in
 * the builder.
 */

import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import { FILE_QUERIES } from './queries'
import { FILE_COMMANDS_TRPC } from './registry'

export type FileProcedures = FamilyProcedures<typeof FILE_COMMANDS_TRPC, typeof FILE_QUERIES>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `files` router. */
export const fileFamilyProcedures = (): FileProcedures =>
  derivedFamilyProcedures({
    family: 'files',
    service: (state) => ({
      rpc: state.modules.rpc,
      artifacts: state.modules.issueArtifacts,
      repos: state.repos,
    }),
    commands: FILE_COMMANDS_TRPC,
    queries: FILE_QUERIES,
  })
