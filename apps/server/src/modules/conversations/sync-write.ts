/**
 * THE CONVERSATION WRITE ON THE SYNC WRITE ENTRY POINT (POD-6412, ADR 12 D2).
 *
 * `conversations.setMeta`, from the family's table, on the sync family builder.
 * The target check is the member floor; whether this reader may see the
 * conversation is the service's own check, which answers an invisible and a
 * missing conversation alike (`ConversationNotFound`).
 *
 * It has no per-command route: no client ever called one, so `sync.submit` is
 * its only door.
 */

import { asUserId } from '@podium/model'
import { ConversationNotFound, type MemoryReaderView } from '../memory/service'
import { humanWithRoleFloor, type SyncFamily, type SyncFamilyState } from '../sync-write/family'
import { CONVERSATION_COMMANDS_TRPC } from './registry'

/** The reader-scoped memory view: the conversations this caller may see. */
export const selectConversationReader = (
  state: Pick<SyncFamilyState, 'modules' | 'caller'>,
): MemoryReaderView =>
  state.modules.memory.forReader({ kind: 'user', id: asUserId(state.caller.userId) })

export const CONVERSATION_SYNC_FAMILY: SyncFamily<
  MemoryReaderView,
  typeof CONVERSATION_COMMANDS_TRPC
> = {
  family: 'conversations',
  service: selectConversationReader,
  commands: CONVERSATION_COMMANDS_TRPC,
  target: async (contract, _input, ctx) => await humanWithRoleFloor(contract, ctx),
  refusalOf: (error) =>
    error instanceof ConversationNotFound
      ? { kind: 'target-not-found', message: error.message }
      : undefined,
}
