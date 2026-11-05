/**
 * THE CONVERSATION SURFACE (POD-314) — `search` from the query table, built by
 * the derived-family builder. Its one write, `setMeta`, is on the sync write
 * entry point only (`sync-write.ts`, POD-6412): no client ever called a route
 * for it, so it has none.
 *
 * Everything `modules/derived-family.ts` claims applies here and is not restated.
 */

import { derivedFamilyProcedures, type QueryProcedures } from '../derived-family'
import { CONVERSATION_QUERIES } from './queries'
import { selectConversationReader } from './sync-write'

export type ConversationProcedures = QueryProcedures<typeof CONVERSATION_QUERIES>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `conversations` router. */
export const conversationFamilyProcedures = (): ConversationProcedures =>
  derivedFamilyProcedures({
    family: 'conversations',
    service: selectConversationReader,
    commands: {},
    queries: CONVERSATION_QUERIES,
  })
