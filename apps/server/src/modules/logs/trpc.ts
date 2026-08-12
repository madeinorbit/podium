/**
 * THE DERIVED LOG-INGESTION SURFACE — `forward` and `crash` from
 * `LOGS_COMMANDS_TRPC`. No queries: reading logs is `podium logs` on the host,
 * not an RPC, and a read that served a client another origin's records would be
 * a new exposure decision rather than a convenience.
 *
 * Everything `modules/derived-family.ts` claims — default-closed exposure,
 * both-directions membership checked at module load, output types read off the
 * joined handler — applies here and is not restated.
 */

import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import { LOGS_COMMANDS_TRPC } from './registry'

const NO_QUERIES = {} as const

export type LogsProcedures = FamilyProcedures<typeof LOGS_COMMANDS_TRPC, typeof NO_QUERIES>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `logs` router. */
export const logsFamilyProcedures = (): LogsProcedures =>
  derivedFamilyProcedures({
    family: 'logs',
    // The emitter is `Pick`ed to the crash tier's entry point by `LogsState`, so
    // the widening a reviewer sees here is exactly what the handler can do.
    service: (state) => ({
      ingest: state.modules.logs,
      telemetry: state.telemetry?.emitter,
    }),
    commands: LOGS_COMMANDS_TRPC,
    queries: NO_QUERIES,
  })
