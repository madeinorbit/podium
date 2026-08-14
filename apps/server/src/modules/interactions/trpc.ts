/**
 * THE DERIVED INTERACTION SURFACE — `answer` from `INTERACTION_COMMANDS_TRPC`,
 * `list` and `forSession` from `INTERACTION_QUERIES`.
 *
 * Three lines of declaration, because the shape lives in
 * `modules/derived-family.ts` and this family differs from its siblings in
 * exactly three respects: which contract table, which service, which query
 * table. Everything that file's header claims — default-closed exposure,
 * both-directions membership checked at module load, output types read off the
 * joined handler so `AppRouter` inference survives — applies here and is not
 * restated.
 */

import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import { INTERACTION_QUERIES } from './queries'
import { INTERACTION_COMMANDS_TRPC } from './registry'

export type InteractionProcedures = FamilyProcedures<
  typeof INTERACTION_COMMANDS_TRPC,
  typeof INTERACTION_QUERIES
>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `interactions` router. */
export const interactionFamilyProcedures = (): InteractionProcedures =>
  derivedFamilyProcedures({
    family: 'interactions',
    service: (state) => state.modules.interactions,
    commands: INTERACTION_COMMANDS_TRPC,
    queries: INTERACTION_QUERIES,
  })
