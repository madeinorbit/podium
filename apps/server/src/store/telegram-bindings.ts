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
import { asc, eq } from 'drizzle-orm'
import { telegramChatBindings } from '../migrations/schema'
import type { StoreQueries, SyncDrizzle, TransactionRunner } from './executor/sync-drizzle'

/** The stored row, as drizzle's own execution path maps it back. */
type BindingRow = typeof telegramChatBindings.$inferSelect

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
function toAttribution(r: BindingRow): Attribution | undefined {
  const kind = r.actorKind
  const id = r.actorId ?? null
  const onBehalfOf = r.onBehalfOf ?? null
  if (kind === 'user') {
    if (!id) return undefined
    return {
      // POLYMORPHIC BRAND DECODE: actor_id shares storage with the system-job
      // arm, so actor_kind is the evidence that this value is a UserId.
      actor: { kind: 'user', id: asUserId(id) },
      onBehalfOf,
    }
  }
  if (kind === 'system') {
    if (!id) return undefined
    return {
      actor: { kind: 'system', job: id },
      onBehalfOf,
    }
  }
  // `agent` and `machine` arms are representable in the model and are not
  // written here: a binding is only ever created by the redemption of a mint a
  // HUMAN made. If one ever appears, it is not a row this reader should invent
  // an interpretation for.
  return undefined
}

/**
 * THE EMPTINESS CHECKS ARE DECISIONS AND STAY (spec §6 rule 6).
 *
 * The `typeof` halves of these guards went with the conversion: they existed
 * only because the raw driver returned `unknown`, and drizzle's own execution
 * path now types these columns off the schema (rule 5, trust the database's
 * types). The `=== ''` halves are not narrowing — an empty chat or user id is a
 * row this reader refuses, on the same fail-closed ground as
 * {@link toAttribution}, and dropping them would admit a binding keyed on the
 * empty string.
 */
function toBinding(r: BindingRow): TelegramChatBinding | undefined {
  if (r.chatId === '') return undefined
  if (r.userId === '') return undefined
  const boundBy = toAttribution(r)
  if (!boundBy) return undefined
  return { chatId: r.chatId, userId: r.userId, boundAt: r.boundAt, boundBy }
}

export class TelegramBindingsRepository {
  private readonly rootDb: SyncDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /** The query builder, resolved on every access so B1 changes this line and nothing else
   *  [POD-3221 spec rule 34a]. */
  protected get db() {
    return this.rootDb
  }

  /** Every binding, for the resolver to answer over. Unreadable rows are omitted
   *  — see {@link toAttribution} on why omission is the fail-closed direction. */
  list(): TelegramChatBinding[] {
    const rows = this.db
      .select()
      .from(telegramChatBindings)
      .orderBy(asc(telegramChatBindings.boundAt))
      .all()
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
   * Write a binding. An upsert on the chat-id primary key: re-running
   * the ceremony for a chat REBINDS it and re-stamps who did so, which is the
   * behaviour that lets a person hand a shared chat over deliberately. It is
   * also why `boundBy` is stored rather than derived — after a rebind, the only
   * record of who took the chat is this row.
   *
   * `INSERT OR REPLACE` became `onConflictDoUpdate`, and the equivalence was
   * checked rather than assumed (POD-3403). `telegram_chat_bindings` has one
   * uniqueness constraint — the `chat_id` primary key, no UNIQUE index — so the
   * conflict target is unambiguous, and the insert names all six columns, so the
   * delete-and-reinsert semantics `OR REPLACE` had cannot revert an omitted
   * column to its default. Nothing references this table, so nothing could have
   * cascaded off the delete either.
   */
  upsert(binding: TelegramChatBinding): void {
    const actor = binding.boundBy.actor
    const values = {
      chatId: binding.chatId,
      userId: binding.userId,
      boundAt: binding.boundAt,
      actorKind: actor.kind,
      actorId: actor.kind === 'system' ? actor.job : actor.id,
      onBehalfOf: binding.boundBy.onBehalfOf,
    }
    this.db
      .insert(telegramChatBindings)
      .values(values)
      .onConflictDoUpdate({ target: telegramChatBindings.chatId, set: values })
      .run()
  }

  /** Remove a binding. The chat stops resolving to anyone on the next message —
   *  no reaper, no cache to invalidate, because resolution reads this table
   *  live. */
  remove(chatId: string): void {
    this.db.delete(telegramChatBindings).where(eq(telegramChatBindings.chatId, chatId)).run()
  }
}
