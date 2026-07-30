/**
 * THE DERIVED CLOUD SURFACE (POD-314) — the five writes from `CLOUD_CONTRACTS`,
 * `capabilities` and `runtime` from the query table.
 *
 * The service is constructed PER REQUEST because its provider comes from the
 * context: `ctx.cloud` is absent on deployments with no cloud runtime, and
 * `CloudService` substitutes the disabled provider once at construction so no
 * method has to remember it.
 */

import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import { CLOUD_QUERIES } from './queries'
import { CLOUD_COMMANDS_TRPC } from './registry'
import { CloudService } from './service'

export type CloudProcedures = FamilyProcedures<typeof CLOUD_COMMANDS_TRPC, typeof CLOUD_QUERIES>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `cloud` router. */
export const cloudFamilyProcedures = (): CloudProcedures =>
  derivedFamilyProcedures({
    family: 'cloud',
    service: (state) =>
      new CloudService({
        provider: state.cloud,
        sessions: state.modules.sessions,
        repos: state.repos,
        store: state.store,
      }),
    commands: CLOUD_COMMANDS_TRPC,
    queries: CLOUD_QUERIES,
  })
