/**
 * THE DERIVED APPROVAL SURFACE (POD-314) — `list` from `APPROVAL_QUERIES`; the
 * decisions `approve` and `deny` are on the sync write entry point since
 * POD-6415 (`sync-write.ts`), their routes thin adapters onto it.
 *
 * Three lines of declaration, because the shape lives in `modules/derived-family.ts`
 * and this family differs from its ten siblings in exactly three respects: which
 * contract table, which service, which query table. Everything the header of that
 * file claims — default-closed exposure, both-directions membership checked at
 * module load against the object that will be served, output types read off the
 * joined handler so `AppRouter` inference survives — applies here and is not
 * restated.
 *
 * A hand-written `.mutation(` cannot reappear in the `approvals` router: the
 * builder modules get has none (`write-routes/write-routes.typecheck.ts`), and
 * `write-routes.test.ts` requires every served mutation to name its registration.
 */

import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import { legacyRouteAdapters } from '../sync-write/family'
import { APPROVAL_QUERIES } from './queries'
import type { APPROVAL_COMMANDS_TRPC } from './registry'
import { APPROVAL_SYNC_FAMILY } from './sync-write'

export type ApprovalProcedures = FamilyProcedures<
  typeof APPROVAL_COMMANDS_TRPC,
  typeof APPROVAL_QUERIES
>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `approvals` router. */
export const approvalFamilyProcedures = (): ApprovalProcedures => ({
  ...derivedFamilyProcedures({
    family: 'approvals',
    service: (state) => state.modules.approvals,
    queries: APPROVAL_QUERIES,
  }),
  // LEGACY(remove-after: 2027-03): the desktop app bundles its own web, whose approval dialog calls these routes. Removing them breaks its decisions.
  ...legacyRouteAdapters(APPROVAL_SYNC_FAMILY, ['approve', 'deny']),
})
