/**
 * PINS, TAB ORDERS AND PERSONAL PREFERENCES AS GENERIC RECORDS (POD-6673,
 * ADR 12 D3; design POD-5620 §1.1-1.3).
 *
 * Each is per-user state (ADR 9 D3 rule 4): its feed id names its user, so the
 * target check reads whose row it is from the id and refuses anyone else's, and
 * the write runs under the caller's own scope (`per-user-row`). The adapters
 * write through the entry point's unit of work: the row and its change entry
 * commit together, and a replay is the entry point's dedup.
 *
 *  - `records.pin.create` / `.remove`: the record's existence is the pin. A
 *    create of a pin that exists keeps it (`recreate: 'keep'`). An issue pin
 *    (POD-6692) names a task that exists, and a pin or unpin that changed
 *    something records `issue.pinned` on the task's activity, for its pinner.
 *  - `records.tabOrder.edit` / `.remove`: the whole list, last writer wins; an
 *    empty list removes the record.
 *  - `records.userPreferences.edit`: the leaves the patch names, through the
 *    settings service (its secret refusal, its value checks, `settings.changed`
 *    after commit); a cleared leaf resets to the default.
 *  - `records.userReadPosition.edit`: a proposed position in one stream,
 *    stored as max(stored, proposed); a proposal behind it changes nothing.
 *    It replaced `readPosition.advance`, so a device queues it offline.
 */

import {
  PIN_RECORD,
  TAB_ORDER_RECORD,
  USER_PREFERENCES_RECORD,
  USER_READ_POSITION_RECORD,
} from '@podium/commands'
import {
  isReadStreamId,
  type PinKind,
  parsePinRowId,
  parseReadPositionRowId,
  parseTabOrderRowId,
  parseUserPreferencesRowId,
  type UserId,
  type UserRole,
} from '@podium/model'
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import type { SessionsRepository } from '../../store/sessions'
import type { ReadPositionService } from '../read-position/service'
import { registerRecordKind } from '../records/generic'
import { USER_PREFERENCES_EDIT } from '../settings/audit'
import { SettingsPatchRefused, type SettingsService } from '../settings/service'
import { SyncWriteRefused } from '../sync-write/entry'
import type { SyncWriteContext, SyncWriteRegistry, SyncWriteTarget } from '../sync-write/registry'
import { pinRemove, pinUpsert, tabOrderChange } from './changes'

export interface UserRecordDeps {
  readonly sessions: () => Pick<
    SessionsRepository,
    'pinnedAt' | 'addPin' | 'removePin' | 'tabOrder' | 'setTabOrder'
  >
  readonly settings: () => Pick<SettingsService, 'updatePreferences' | 'recordCommand'>
  readonly readPositions: () => Pick<ReadPositionService, 'advance'>
  /** May this caller read this session? A panel pin names one. */
  readonly canReadSession: (principal: CommandPrincipal, sessionId: string) => Promise<boolean>
  /** Does this task exist? An issue pin names one (every member reads every
   *  task, design §2.2). */
  readonly issueExists: (issueId: string) => Promise<boolean>
  /** Record that a member pinned or unpinned a task (`issue.pinned`). */
  readonly issuePinChanged: (userId: UserId, issueId: string, pinned: boolean) => Promise<void>
  /** The account's live role, or undefined (disabled, or no account). */
  readonly roleOf: (user: UserId) => Promise<UserRole | undefined>
  readonly now?: () => string
}

/** The human a principal writes for, or undefined (a system principal, none). */
function humanOf(principal: CommandPrincipal): UserId | undefined {
  if (principal.kind === 'system') return undefined
  return onBehalfOfUser(principal) ?? undefined
}

/** Parse a row id, or undefined when it is malformed. */
function parsed<T>(parse: (id: string) => T, id: string): T | undefined {
  try {
    return parse(id)
  } catch {
    return undefined
  }
}

const gone = (): never => {
  throw new SyncWriteRefused({ kind: 'target-not-found' })
}

export function registerUserRecords(registry: SyncWriteRegistry, deps: UserRecordDeps): void {
  const now = deps.now ?? (() => new Date().toISOString())
  /**
   * The caller's own row, while their account holds the kinds' role floor
   * (member) NOW: a disabled account has no role and is refused whatever its
   * capability says, as the per-command gates these writes replaced did.
   */
  const own = async (userId: UserId): Promise<SyncWriteTarget> =>
    (await deps.roleOf(userId)) === undefined ? undefined : { kind: 'per-user-row', userId }

  // ---- pin ----------------------------------------------------------------
  const ownPin = (id: string, principal: CommandPrincipal) => {
    const key = parsed(parsePinRowId, id)
    const human = humanOf(principal)
    return key !== undefined && human !== undefined && key.userId === human ? key : undefined
  }
  const pinOrGone = (id: string, principal: CommandPrincipal) => ownPin(id, principal) ?? gone()

  registerRecordKind(registry, PIN_RECORD, {
    target: async (op, id, { principal }) => {
      const key = ownPin(id, principal)
      if (key === undefined) return undefined
      // A panel pin names a session: one the caller may not read is unknown.
      if (key.kind === 'panel' && !(await deps.canReadSession(principal, key.entityId))) {
        return undefined
      }
      // An issue pin names a task: pinning one that does not exist is unknown.
      // Unpinning is always mine to do, the task gone or not.
      if (key.kind === 'issue' && op === 'create' && !(await deps.issueExists(key.entityId))) {
        return undefined
      }
      return await own(key.userId)
    },
    read: async (id) => {
      const key = parsed(parsePinRowId, id)
      if (key === undefined) return undefined
      const at = await deps.sessions().pinnedAt(key.userId, key.kind, key.entityId)
      return at === undefined ? undefined : {}
    },
    create: async (ctx, id, fields) => {
      const key = pinOrGone(id, ctx.principal)
      // The id is the key: the fields may only restate it.
      if (
        fields.userId !== key.userId ||
        fields.kind !== key.kind ||
        fields.entityId !== key.entityId
      ) {
        throw new SyncWriteRefused({ kind: 'invalid', details: ['fields'] })
      }
      const at = now()
      const { result } = await ctx.ledger.commit({
        write: async () =>
          await deps.sessions().addPin(key.userId, key.kind as PinKind, key.entityId, at),
        changes: ({ pin }) => [pinUpsert(pin)],
      })
      if (key.kind === 'issue' && result.created) {
        await deps.issuePinChanged(key.userId, key.entityId, true)
      }
      return { ok: true }
    },
    remove: async (ctx, id) => {
      const key = pinOrGone(id, ctx.principal)
      const { result: removed } = await ctx.ledger.commit({
        write: async () => await deps.sessions().removePin(key.userId, key.kind, key.entityId),
        // Unpinning what is not pinned changes nothing.
        changes: (removed) => (removed ? [pinRemove(key.userId, key.kind, key.entityId)] : []),
      })
      if (key.kind === 'issue' && removed) await deps.issuePinChanged(key.userId, key.entityId, false)
      return { ok: true }
    },
  })

  // ---- tabOrder -------------------------------------------------------------
  const ownOrder = (id: string, principal: CommandPrincipal) => {
    const key = parsed(parseTabOrderRowId, id)
    const human = humanOf(principal)
    return key !== undefined && human !== undefined && key.userId === human ? key : undefined
  }
  const writeOrder = async (
    ctx: SyncWriteContext,
    userId: UserId,
    worktree: string,
    sessionIds: readonly string[],
  ) => {
    await ctx.ledger.commit({
      write: async () => {
        const before = await deps.sessions().tabOrder(userId, worktree)
        await deps.sessions().setTabOrder(userId, worktree, [...sessionIds])
        return before
      },
      // Removing an order that was never set changes nothing.
      changes: (before) =>
        sessionIds.length === 0 && before === undefined
          ? []
          : [tabOrderChange(userId, worktree, sessionIds)],
    })
    return { ok: true }
  }

  registerRecordKind(registry, TAB_ORDER_RECORD, {
    target: async (_op, id, { principal }, edited) => {
      const key = ownOrder(id, principal)
      if (key === undefined) return undefined
      // An order may name only sessions the caller can read: one naming
      // anybody else's is refused whole, as `tabs.setOrder` was.
      const ids = edited?.patch.sessionIds
      if (Array.isArray(ids)) {
        const readable = await Promise.all(
          ids.map(async (sessionId) =>
            typeof sessionId === 'string' ? await deps.canReadSession(principal, sessionId) : false,
          ),
        )
        if (readable.some((ok) => !ok)) return undefined
      }
      return await own(key.userId)
    },
    edit: async (ctx, id, patch) => {
      const key = ownOrder(id, ctx.principal) ?? gone()
      const ids = patch.sessionIds as readonly string[] | undefined
      if (ids === undefined) return { ok: true }
      return await writeOrder(ctx, key.userId, key.worktree, ids)
    },
    remove: async (ctx, id) => {
      const key = ownOrder(id, ctx.principal) ?? gone()
      return await writeOrder(ctx, key.userId, key.worktree, [])
    },
  })

  // ---- userPreferences --------------------------------------------------------
  const ownPreferences = (id: string, principal: CommandPrincipal) => {
    const key = parsed(parseUserPreferencesRowId, id)
    const human = humanOf(principal)
    return key !== undefined && human !== undefined && key.userId === human ? key : undefined
  }

  // THE SETTINGS AUDIT TRAIL KEEPS ITS ROWS. A personal write is recorded in
  // `settings_audit_events` as `settings.updatePersonal` was: applied once it
  // committed (the row commits with the write), refused when the gate refuses.
  const audit = async (
    principal: CommandPrincipal,
    input: unknown,
    outcome: 'applied' | 'refused',
    error?: string,
  ) =>
    await deps.settings().recordCommand({
      command: USER_PREFERENCES_EDIT,
      outcome,
      principal,
      input,
      ...(error !== undefined ? { error } : {}),
    })

  registerRecordKind(registry, USER_PREFERENCES_RECORD, {
    target: async (_op, id, { principal }, edited) => {
      const key = ownPreferences(id, principal)
      if (key !== undefined) return await own(key.userId)
      await audit(
        principal,
        { id, patch: edited?.patch ?? {}, unset: edited?.unset ?? [] },
        'refused',
        'not your settings record',
      )
      return undefined
    },
    edit: async (ctx, id, patch, _expected, unset) => {
      const { userId } = ownPreferences(id, ctx.principal) ?? gone()
      // A cleared leaf is `undefined` in the service's patch: the row goes and
      // the leaf resolves to its default again.
      const values: Record<string, unknown> = {}
      for (const [path, value] of Object.entries(patch)) {
        if (value !== undefined && path !== 'userId') values[path] = value
      }
      for (const path of unset) values[path] = undefined
      if (Object.keys(values).length === 0) return { ok: true }
      try {
        await deps.settings().updatePreferences(userId, values, ctx.ledger)
      } catch (error) {
        if (error instanceof SettingsPatchRefused) {
          throw new SyncWriteRefused({ kind: 'invalid', message: error.message }, { cause: error })
        }
        throw error
      }
      await audit(ctx.principal, { id, patch, unset }, 'applied')
      return { ok: true }
    },
  })

  // ---- userReadPosition -------------------------------------------------------
  const ownPosition = (id: string, principal: CommandPrincipal) => {
    const key = parsed(parseReadPositionRowId, id)
    const human = humanOf(principal)
    return key !== undefined &&
      human !== undefined &&
      key.userId === human &&
      isReadStreamId(key.streamId)
      ? key
      : undefined
  }

  registerRecordKind(registry, USER_READ_POSITION_RECORD, {
    target: async (_op, id, { principal }) => {
      const key = ownPosition(id, principal)
      return key === undefined ? undefined : await own(key.userId)
    },
    edit: async (ctx, id, patch, _expected, unset) => {
      const { userId, streamId } = ownPosition(id, ctx.principal) ?? gone()
      const lastEventId = patch.lastEventId
      // A position is the whole proposal: an edit that names no event id, or
      // clears one, proposes nothing a max could keep.
      if (typeof lastEventId !== 'number' || unset.includes('lastEventId')) {
        throw new SyncWriteRefused({ kind: 'invalid', details: ['lastEventId'] })
      }
      const seenAt = typeof patch.seenAt === 'string' ? patch.seenAt : null
      await deps
        .readPositions()
        .advance(ctx.ledger, userId, streamId, { lastEventId, seenAt }, now())
      return { ok: true }
    },
  })
}
