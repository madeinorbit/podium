/**
 * `notices.list` and `notices.unreadCount` (POD-6881, spec §13): the CALLER's
 * own open notices. The apps read the synced `inboxNotice` records; these serve
 * the CLI and the API. A person only: an agent's call is refused, since a
 * notice is for the human and not for the agents working for them.
 */

import { noticeListInput } from '@podium/commands'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { FamilyState } from '../derived-family'
import { defineQuery } from '../query-table'

const q = defineQuery<FamilyState>()

function person(s: FamilyState) {
  if (s.principal?.kind !== 'user') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only a person reads their notices.' })
  }
  return s.principal.user
}

export const NOTICE_QUERIES = {
  list: q(noticeListInput, async (s, input) => await s.modules.notices.list(person(s), input)),
  unreadCount: q(
    z.object({}).passthrough().optional(),
    async (s) => await s.modules.notices.unreadCount(person(s)),
  ),
} as const
