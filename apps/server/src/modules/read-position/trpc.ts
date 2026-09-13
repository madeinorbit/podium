/**
 * THE FEED-CURSOR SURFACE (POD-1380), DERIVED (PDM-308).
 *
 * Two procedures — `get`, `advance` — hand-written here until this issue, and
 * joined to their contract for `.name` and `.input` but never for `.exposure`.
 * This family is the sharper half of the defect: it has no contracts test
 * anywhere, so nothing restated its declared transports either, and
 * `readPosition.advance` could declare any transport set at all — `['mcp']`,
 * or nothing — while this router kept serving it on tRPC and every lane stayed
 * green. See `./registry` and `../layout/registry.ts` for the measurement.
 *
 * `./authz` stays and still runs, for the reason `../layout/trpc.ts` gives: the
 * contract declares `roleFloor: 'member'`, which the builder does not gate, and
 * this family's own gate refuses an absent role at that floor. It is pre-bound
 * as a port — see `../per-user-actor-gate.ts`.
 */

import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import {
  READ_POSITION_COMMANDS_TRPC,
  READ_POSITION_QUERIES,
  selectReadPositionState,
} from './registry'

export type ReadPositionProcedures = FamilyProcedures<
  typeof READ_POSITION_COMMANDS_TRPC,
  typeof READ_POSITION_QUERIES
>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `readPosition` router. */
export const readPositionFamilyProcedures = (): ReadPositionProcedures =>
  derivedFamilyProcedures({
    family: 'readPosition',
    service: (state) => selectReadPositionState(state.modules, state.readPositionActors),
    commands: READ_POSITION_COMMANDS_TRPC,
    queries: READ_POSITION_QUERIES,
  })
