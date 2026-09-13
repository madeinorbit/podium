/**
 * THE DERIVED FILE SURFACE (POD-314) — `write` from the contract table, `read`
 * and `list` from the query table.
 *
 * THE SELECTOR RETURNS ONE THING (PDM-272). It used to return the three the
 * family reaches — the daemon RPC, the artifact store and the repo registry —
 * and that visible widening was the defect rather than the safeguard: three
 * capabilities and no identity, so the reads authorized on the path. It now
 * takes the pre-bound `fileTargets` gate off the state bundle, which is where
 * this request's principal was read and the only place it is read.
 */

import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import { FILE_QUERIES } from './queries'
import { FILE_COMMANDS_TRPC } from './registry'

export type FileProcedures = FamilyProcedures<typeof FILE_COMMANDS_TRPC, typeof FILE_QUERIES>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `files` router. */
export const fileFamilyProcedures = (): FileProcedures =>
  derivedFamilyProcedures({
    family: 'files',
    service: (state) => ({ files: state.fileTargets }),
    commands: FILE_COMMANDS_TRPC,
    queries: FILE_QUERIES,
  })
