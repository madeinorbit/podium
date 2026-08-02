/**
 * THE DERIVED CONVERSATION SURFACE (POD-314) — `setMeta` from the contract table,
 * `search` from the query table, both built by the one derived-family builder.
 *
 * Everything `modules/derived-family.ts` claims applies here and is not restated.
 */

import { asUserId } from '@podium/model'
import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import { CONVERSATION_QUERIES } from './queries'
import { CONVERSATION_COMMANDS_TRPC } from './registry'

export type ConversationProcedures = FamilyProcedures<
  typeof CONVERSATION_COMMANDS_TRPC,
  typeof CONVERSATION_QUERIES
>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `conversations` router. */
export const conversationFamilyProcedures = (): ConversationProcedures =>
  derivedFamilyProcedures({
    family: 'conversations',
    service: (state) => state.modules.memory.forReader({ kind: 'user', id: asUserId(state.caller.userId) }),
    commands: CONVERSATION_COMMANDS_TRPC,
    queries: CONVERSATION_QUERIES,
  })
