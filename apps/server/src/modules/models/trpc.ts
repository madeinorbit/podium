/**
 * THE DERIVED MODEL SURFACE (POD-314) — `refresh` from the contract table,
 * `catalog` from the query table. Both reach `SettingsService`, which has always
 * owned the catalog; see `registry.ts` for why the router key and the service
 * name differ.
 */

import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import { MODEL_QUERIES } from './queries'
import { MODEL_COMMANDS_TRPC } from './registry'

export type ModelProcedures = FamilyProcedures<typeof MODEL_COMMANDS_TRPC, typeof MODEL_QUERIES>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `models` router. */
export const modelFamilyProcedures = (): ModelProcedures =>
  derivedFamilyProcedures({
    family: 'models',
    service: (state) => state.modules.settings,
    commands: MODEL_COMMANDS_TRPC,
    queries: MODEL_QUERIES,
  })
