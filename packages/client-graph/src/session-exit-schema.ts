import type { ReferentExit } from '@podium/client-core/values'

export interface SessionExitRows { sessionExit: { kind: ReferentExit | undefined } }
declare module './source-registry' { interface PoolSourceRows extends SessionExitRows {} }
export const SESSION_EXIT_ENTITIES = ['sessionExit'] as const
