/**
 * THE TELEGRAM CHAT BINDING TABLE (POD-1080) — the persistence half of
 * `@podium/model`'s `TelegramChatBinding`, and the only thing an inbound message
 * is allowed to be resolved against.
 *
 * ADR 3 Amendment 1 D22.1/D22.2, ADR 1 matrix row `telegram-chat-binding`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE STORE ENFORCES THAT THE MODEL CANNOT
 * ---------------------------------------------------------------------------
 *
 * One row per chat, by primary key. The model's resolver refuses on ambiguity
 * (`reason: 'ambiguous'`) and that refusal must stay reachable — a model that
 * trusts a constraint it cannot see fails open the day the constraint is
 * dropped — but the constraint is what makes the refusal never fire in practice.
 * Two rows for one chat would otherwise force a choice, and whoever can cause
 * the second row would win it.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO `resolve(chatId)` QUERY HERE
 * ---------------------------------------------------------------------------
 *
 * Deliberate. A `SELECT … WHERE chat_id = ?` returning a user would be a SECOND
 * implementation of the resolution rule — one that cannot express `ambiguous`,
 * and one that would quietly become the real gate because it is the convenient
 * one. This repository answers "which bindings exist" and
 * `resolveTelegramPrincipal` answers "who is this", once, in the model where its
 * refusing arms are unit-testable. `audit:telegram-binding` checks that nothing
 * else resolves a chat to a user.
 */

import type { Attribution, TelegramChatBinding, UserId } from '@podium/model'
import { asUserId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'

/**
 * Rebuild the attribution pair from its three columns — the same shape
 * `grants` stores.
 *
 * FAILS CLOSED on an actor kind this build has never heard of: the row is
 * dropped from the answer entirely rather than admitted with a guessed actor.
 * An unreadable binding must deny, because the alternative is a row written by a
 * newer version (or by hand) resolving to a user under a kind nothing checked —
 * the unknown-input-fails-open shape.
 */
function toAttribution(r: Record<string, unknown>): Attribution | undefined {
  const kind = r.actor_kind
  const id = (r.actor_id as string | null | undefined) ?? null
  const onBehalfOf = (r.on_behalf_of as string | null | undefined) ?? null
  if (kind === 'user') {
    if (!id) return undefined
    return { actor: { kind: 'user', id: asUserId(id) }, onBehalfOf: onBehalfOf ? asUserId(onBehalfOf) : null }
  }
  if (kind === 'system') {
    if (!id) return undefined
    return { actor: { kind: 'system', job: id }, onBehalfOf: onBehalfOf ? asUserId(onBehalfOf) : null }
  }
  // `agent` and `machine` arms are representable in the model and are not
  // written here: a binding is only ever created by the redemption of a mint a
  // HUMAN made. If one ever appears, it is not a row this reader should invent
  // an interpretation for.
  return undefined
}

function toBinding(r: Record<string, unknown>): TelegramChatBinding | undefined {
  const chatId = r.chat_id
  const userId = r.user_id
  const boundAt = r.bound_at
  if (typeof chatId !== 'string' || chatId === '') return undefined
  if (typeof userId !== 'string' || userId === '') return undefined
  if (typeof boundAt !== 'string') return undefined
  const boundBy = toAttribution(r)
  if (!boundBy) return undefined
  return { chatId, userId: asUserId(userId), boundAt, boundBy }
}

export class TelegramBindingsRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** Every binding, for the resolver to answer over. Unreadable rows are omitted
   *  — see {@link toAttribution} on why omission is the fail-closed direction. */
  list(): TelegramChatBinding[] {
    const rows = this.db
      .prepare('SELECT * FROM telegram_chat_bindings ORDER BY bound_at ASC')
      .all() as Record<string, unknown>[]
    return rows.flatMap((r) => {
      const binding = toBinding(r)
      return binding ? [binding] : []
    })
  }

  /** One person's bindings — the read a settings surface needs to show someone
   *  which chats speak as them. */
  listForUser(userId: UserId): TelegramChatBinding[] {
    return this.list().filter((b) => b.userId === userId)
  }

  /**
   * Write a binding. `INSERT OR REPLACE` on the chat-id primary key: re-running
   * the ceremony for a chat REBINDS it and re-stamps who did so, which is the
   * behaviour that lets a person hand a shared chat over deliberately. It is
   * also why `boundBy` is stored rather than derived — after a rebind, the only
   * record of who took the chat is this row.
   */
  upsert(binding: TelegramChatBinding): void {
    const actor = binding.boundBy.actor
    this.db
      .prepare(
        `INSERT OR REPLACE INTO telegram_chat_bindings
           (chat_id, user_id, bound_at, actor_kind, actor_id, on_behalf_of)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        binding.chatId,
        binding.userId,
        binding.boundAt,
        actor.kind,
        actor.kind === 'system' ? actor.job : actor.id,
        binding.boundBy.onBehalfOf,
      )
  }

  /** Remove a binding. The chat stops resolving to anyone on the next message —
   *  no reaper, no cache to invalidate, because resolution reads this table
   *  live. */
  remove(chatId: string): void {
    this.db.prepare('DELETE FROM telegram_chat_bindings WHERE chat_id = ?').run(chatId)
  }
}
