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

import type { FamilyProcedures } from '../derived-family'
import { plainFamilyProcedures } from '../plain-command/family'
import { LOGS_PLAIN_FAMILY } from './plain-family'
import type { LOGS_COMMANDS_TRPC } from './registry'

const NO_QUERIES = {} as const

export type LogsProcedures = FamilyProcedures<typeof LOGS_COMMANDS_TRPC, typeof NO_QUERIES>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `logs` router. */
export const logsFamilyProcedures = (): LogsProcedures =>
  plainFamilyProcedures(LOGS_PLAIN_FAMILY, NO_QUERIES)
