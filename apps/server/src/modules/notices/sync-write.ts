/**
 * MARKING NOTICES READ ON THE SYNC WRITE ENTRY POINT (POD-6881, spec §13).
 *
 * `notices.markRead` and `notices.markAllRead` write the CALLER's own rows: the
 * resolver refuses anyone who is not a person signed in as themselves (an
 * agent, the system), and the handler scopes every write by the caller's id,
 * so another member's notice id, an admin's call included, answers as unknown.
 * The read marks reach the caller's devices as `inboxNotice` changes, inside
 * the command's unit of work.
 */

import { noticeCommands } from '@podium/commands'
import type { UserId } from '@podium/model'
import type { CommandPrincipal } from '../../command-principal'
import { SyncWriteRefused } from '../sync-write/entry'
import { NO_TARGET, refuseTarget, type SyncWriteRegistry } from '../sync-write/registry'
import type { NoticeService } from './emit'

export interface NoticeSyncWriteDeps {
  notices(): Pick<NoticeService, 'markRead' | 'markAllRead'>
}

const PERSON_ONLY = refuseTarget({
  kind: 'unauthorized',
  message: 'Only the person a notice is for can mark it read.',
})

/** The person behind the call, never an agent acting for them. */
const personOf = (principal: CommandPrincipal): UserId | undefined =>
  principal.kind === 'user' ? principal.user : undefined

const requirePerson = (principal: CommandPrincipal): UserId => {
  const user = personOf(principal)
  if (user === undefined) throw new SyncWriteRefused(PERSON_ONLY.syncWriteRefused)
  return user
}

export function registerNoticeCommands(
  registry: SyncWriteRegistry,
  deps: NoticeSyncWriteDeps,
): void {
  registry.register({
    name: 'notices.markRead',
    def: noticeCommands.defs.markRead,
    target: (_input, { principal }) =>
      personOf(principal) === undefined ? PERSON_ONLY : NO_TARGET,
    // `marked: false` for a notice that is not the caller's, not open, or
    // already read: one answer, so the reply is no oracle for another's ids.
    handle: async (ctx, input) => ({
      marked: await deps.notices().markRead(requirePerson(ctx.principal), input.id),
    }),
  })
  registry.register({
    name: 'notices.markAllRead',
    def: noticeCommands.defs.markAllRead,
    target: (_input, { principal }) =>
      personOf(principal) === undefined ? PERSON_ONLY : NO_TARGET,
    handle: async (ctx) => ({
      marked: await deps.notices().markAllRead(requirePerson(ctx.principal)),
    }),
  })
}
