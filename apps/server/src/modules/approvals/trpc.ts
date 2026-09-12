/**
 * THE DERIVED APPROVAL SURFACE (POD-314) — `approve` and `deny` from
 * `APPROVAL_COMMANDS_TRPC`, `list` from `APPROVAL_QUERIES`.
 *
 * Three lines of declaration, because the shape lives in `modules/derived-family.ts`
 * and this family differs from its ten siblings in exactly three respects: which
 * contract table, which service, which query table. Everything the header of that
 * file claims — default-closed exposure, both-directions membership checked at
 * module load against the object that will be served, output types read off the
 * joined handler so `AppRouter` inference survives — applies here and is not
 * restated.
 *
 * `scripts/audit-router-mutations.ts` fails the build if a hand-written
 * `.mutation(` reappears in the `approvals` router.
 */

import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import { APPROVAL_QUERIES } from './queries'
import { APPROVAL_COMMANDS_TRPC } from './registry'

export type ApprovalProcedures = FamilyProcedures<
  typeof APPROVAL_COMMANDS_TRPC,
  typeof APPROVAL_QUERIES
>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `approvals` router. */
export const approvalFamilyProcedures = (): ApprovalProcedures =>
  derivedFamilyProcedures({
    family: 'approvals',
    // THE WHOLE STATE, not `state.modules.approvals` (B1, PDM-133). Both the
    // decision commands and the `list` read need the caller's identity, and the
    // family's `service` selector is the seam that carries it — see the notes in
    // `registry.ts` and `queries.ts`.
    service: (state) => state,
    commands: APPROVAL_COMMANDS_TRPC,
    queries: APPROVAL_QUERIES,
  })
