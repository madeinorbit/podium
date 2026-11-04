/**
 * A PERSON'S STATE ON A SESSION AS A GENERIC RECORD (ADR 12 D3, POD-6391).
 *
 * `sessionUserState` is per-user state (ADR 9 D3 rule 4): one row per
 * `(user, session)`, `single-writer` because the user is in the key. The record's
 * id is the feed's row id, `userEntityKey(user, session)`, so the target check
 * reads whose row it is from the id itself and refuses anyone else's. Then the
 * session must be one the caller may read, as for `sessions.markRead`.
 *
 * An edit writes exactly the patched value; a remove forgets the caller's read
 * mark and snooze together.
 */

import { SESSION_USER_STATE_RECORD } from '@podium/commands'
import { parseSessionUserStateRowId, type SessionId } from '@podium/model'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import {
  type SessionStatePrincipal,
  sessionStatePrincipalFor,
} from '../sessions/session-state/registry'
import { SyncWriteRefused } from '../sync-write/entry'
import type { SyncWriteRegistry } from '../sync-write/registry'
import { registerRecordKind } from './generic'

export interface SessionUserStateRecordDeps {
  modules(): RegistryModules
}

/** The row's session, when the row is the caller's own; else undefined. */
function ownRow(
  id: string,
  principal: CommandPrincipal,
): { caller: SessionStatePrincipal; sessionId: SessionId } | undefined {
  if (principal.kind === 'system') return undefined
  const caller = sessionStatePrincipalFor(principal)
  let key: ReturnType<typeof parseSessionUserStateRowId>
  try {
    key = parseSessionUserStateRowId(id)
  } catch {
    return undefined
  }
  return key.userId === caller.userId ? { caller, sessionId: key.sessionId } : undefined
}

const gone = (): never => {
  throw new SyncWriteRefused({ kind: 'target-not-found' })
}

export function registerSessionUserStateRecord(
  registry: SyncWriteRegistry,
  deps: SessionUserStateRecordDeps,
): void {
  const state = () => deps.modules().sessions.state
  const rowFor = (id: string, principal: CommandPrincipal) => ownRow(id, principal) ?? gone()

  registerRecordKind(registry, SESSION_USER_STATE_RECORD, {
    target: async (_op, id, { principal }) => {
      const row = ownRow(id, principal)
      if (row === undefined) return undefined
      if (!(await state().canReadSession(row.caller, row.sessionId))) return undefined
      return { kind: 'per-user-row', userId: row.caller.userId }
    },
    edit: async (ctx, id, patch) => {
      const { caller, sessionId } = rowFor(id, ctx.principal)
      if (patch.readAt === undefined) return { ok: true }
      const readAt = patch.readAt as string | null
      if (!(await state().setReadAt(caller, sessionId, readAt))) gone()
      return { ok: true }
    },
    remove: async (ctx, id) => {
      const { caller, sessionId } = rowFor(id, ctx.principal)
      if (!(await state().clearUserState(caller, sessionId))) gone()
      return { ok: true }
    },
  })
}
