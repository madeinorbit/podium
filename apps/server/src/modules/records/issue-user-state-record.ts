/**
 * A PERSON'S STATE ON AN ISSUE AS A GENERIC RECORD (ADR 12 D3, POD-6404).
 *
 * `issueUserState` is per-user state (ADR 9 D3 rule 4): one row per
 * `(user, issue)`, `single-writer` because the user is in the key. The record's
 * id is the feed's row id, `issueUserStateRowId(user, issue)`, so the target
 * check reads whose row it is from the id and refuses anyone else's.
 *
 * The writes are the issue family's own (`markIssueRead`, `markIssueUnread`,
 * `setIssueTucked`), FOR THE CALLER: before this, the per-user issue commands
 * wrote the broadcast viewer's row (the first admin), whoever pressed. The
 * family keeps its rules: a read mark never moves backwards, only a finished
 * issue can be tucked, and a re-tuck keeps its first stamp.
 */

import { ISSUE_USER_STATE_RECORD } from '@podium/commands'
import { type IssueId, parseIssueUserStateRowId, type UserId } from '@podium/model'
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import { issueRefusalOf } from '../issues/sync-write'
import { SyncWriteRefused } from '../sync-write/entry'
import type { SyncWriteRegistry } from '../sync-write/registry'
import { registerRecordKind } from './generic'

export interface IssueUserStateRecordDeps {
  modules(): RegistryModules
}

/** The row's issue, when the row is the caller's own; else undefined. */
function ownRow(
  id: string,
  principal: CommandPrincipal,
): { userId: UserId; issueId: IssueId } | undefined {
  if (principal.kind === 'system') return undefined
  const caller = onBehalfOfUser(principal)
  if (caller === null) return undefined
  let key: ReturnType<typeof parseIssueUserStateRowId>
  try {
    key = parseIssueUserStateRowId(id)
  } catch {
    return undefined
  }
  return key.userId === caller ? { userId: caller, issueId: key.entityId } : undefined
}

/** An issue family error as the entry point's refusal. */
async function family<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    const refusal = issueRefusalOf(error)
    if (refusal === undefined) throw error
    throw new SyncWriteRefused(refusal, { cause: error })
  }
}

export function registerIssueUserStateRecord(
  registry: SyncWriteRegistry,
  deps: IssueUserStateRecordDeps,
): void {
  const attention = () => deps.modules().issues.attention

  registerRecordKind(registry, ISSUE_USER_STATE_RECORD, {
    // As `issues.markRead`: the caller's own row; the family refuses an issue
    // that does not exist.
    target: async (_op, id, { principal }) => {
      const row = ownRow(id, principal)
      return row === undefined ? undefined : { kind: 'per-user-row', userId: row.userId }
    },
    edit: async (ctx, id, patch) => {
      const row = ownRow(id, ctx.principal)
      if (row === undefined) throw new SyncWriteRefused({ kind: 'target-not-found' })
      const { userId, issueId } = row
      if (patch.readAt !== undefined) {
        const readAt = patch.readAt as string | null
        await family(async () =>
          readAt === null
            ? await attention().markIssueUnread(issueId, userId)
            : await attention().markIssueRead(issueId, readAt, userId),
        )
      }
      if (patch.tuckedAt !== undefined) {
        const tucked = patch.tuckedAt !== null
        await family(async () => await attention().setIssueTucked(issueId, tucked, userId))
      }
      return { ok: true }
    },
  })
}
