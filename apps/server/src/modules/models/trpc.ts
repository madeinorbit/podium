/**
 * THE DERIVED MODEL SURFACE (POD-314) — `refresh` from the contract table,
 * `catalog` from the query table. Both reach `SettingsService`, which has always
 * owned the catalog; see `registry.ts` for why the router key and the service
 * name differ. `selectModelState` also names `defaultMachine` so an omitted
 * machineId still resolves to one machine rather than a global singleton.
 */

import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import { MODEL_QUERIES } from './queries'
import { MODEL_COMMANDS_TRPC, selectModelState } from './registry'

export type ModelProcedures = FamilyProcedures<typeof MODEL_COMMANDS_TRPC, typeof MODEL_QUERIES>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `models` router. */
export const modelFamilyProcedures = (): ModelProcedures =>
  derivedFamilyProcedures({
    family: 'models',
    service: (state) => selectModelState(state.modules),
    commands: MODEL_COMMANDS_TRPC,
    queries: MODEL_QUERIES,
  })
