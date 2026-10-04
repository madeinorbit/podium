import type { ReferentExit } from '@podium/client-core/values'

export interface SessionExitRows { sessionExit: { kind: ReferentExit | undefined } }
declare module './source-registry' { interface PoolSourceRows extends SessionExitRows {} }
export const SESSION_EXIT_ENTITIES = ['sessionExit'] as const
export const SESSION_EXIT_SCHEMA = {
  sessionExit: { key: 'sessionId', source: 'replica:exitKind(session,sessionId)', fields: ['kind'], residency: 'addressed-on-demand' },
} as const
