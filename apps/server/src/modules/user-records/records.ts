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
 *    create of a pin that exists keeps it (`recreate: 'keep'`).
 *  - `records.tabOrder.edit` / `.remove`: the whole list, last writer wins; an
 *    empty list removes the record.
 *  - `records.userPreferences.edit`: the leaves the patch names, through the
 *    settings service (its secret refusal, its value checks, `settings.changed`
 *    after commit); a cleared leaf resets to the default.
 */

import { PIN_RECORD, TAB_ORDER_RECORD, USER_PREFERENCES_RECORD } from '@podium/commands'
import {
  type PinKind,
  parsePinRowId,
  parseTabOrderRowId,
  parseUserPreferencesRowId,
  type UserId,
} from '@podium/model'
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import type { SessionsRepository } from '../../store/sessions'
import { registerRecordKind } from '../records/generic'
import { SettingsPatchRefused, type SettingsService } from '../settings/service'
import { SyncWriteRefused } from '../sync-write/entry'
import type { SyncWriteContext, SyncWriteRegistry, SyncWriteTarget } from '../sync-write/registry'
import { pinRemove, pinUpsert, tabOrderChange } from './changes'

export interface UserRecordDeps {
  readonly sessions: () => Pick<
    SessionsRepository,
    'pinnedAt' | 'addPin' | 'removePin' | 'tabOrder' | 'setTabOrder'
  >
  readonly settings: () => Pick<SettingsService, 'updatePreferences'>
  /** May this caller read this session? A panel pin names one. */
  readonly canReadSession: (principal: CommandPrincipal, sessionId: string) => Promise<boolean>
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

const own = (userId: UserId): SyncWriteTarget => ({ kind: 'per-user-row', userId })

export function registerUserRecords(registry: SyncWriteRegistry, deps: UserRecordDeps): void {
  const now = deps.now ?? (() => new Date().toISOString())

  // ---- pin ----------------------------------------------------------------
  const ownPin = (id: string, principal: CommandPrincipal) => {
    const key = parsed(parsePinRowId, id)
    const human = humanOf(principal)
    return key !== undefined && human !== undefined && key.userId === human ? key : undefined
  }
  const pinOrGone = (id: string, principal: CommandPrincipal) => ownPin(id, principal) ?? gone()

  registerRecordKind(registry, PIN_RECORD, {
    target: async (_op, id, { principal }) => {
      const key = ownPin(id, principal)
      if (key === undefined) return undefined
      // A panel pin names a session: one the caller may not read is unknown.
      if (key.kind === 'panel' && !(await deps.canReadSession(principal, key.entityId))) {
        return undefined
      }
      return own(key.userId)
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
      await ctx.ledger.commit({
        write: async () =>
          await deps.sessions().addPin(key.userId, key.kind as PinKind, key.entityId, at),
        changes: (pin) => [pinUpsert(pin)],
      })
      return { ok: true }
    },
    remove: async (ctx, id) => {
      const key = pinOrGone(id, ctx.principal)
      await ctx.ledger.commit({
        write: async () => await deps.sessions().removePin(key.userId, key.kind, key.entityId),
        // Unpinning what is not pinned changes nothing.
        changes: (removed) => (removed ? [pinRemove(key.userId, key.kind, key.entityId)] : []),
      })
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
      return own(key.userId)
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

  registerRecordKind(registry, USER_PREFERENCES_RECORD, {
    target: async (_op, id, { principal }) => {
      const key = ownPreferences(id, principal)
      return key === undefined ? undefined : own(key.userId)
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
      return { ok: true }
    },
  })
}
