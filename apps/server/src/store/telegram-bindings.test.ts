/**
 * THE BINDING TABLE, AGAINST A REAL MIGRATED DATABASE (POD-1080).
 *
 * These run the SHIPPED migration manifest against an in-memory database, so a
 * missing `telegram_chat_bindings` table fails HERE rather than at boot on
 * somebody's laptop — and the primary-key claim below is a claim about what
 * SQLite does, which a fake repository would agree with whatever this file
 * asserted.
 *
 * Every denial is paired with an admission in the SAME fixture, so no assertion
 * can be satisfied by a repository that returns nothing.
 */

import type { TelegramChatBinding } from '@podium/model'
import { asUserId, resolveTelegramPrincipal } from '@podium/model'
import type { openDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { TelegramBindingsRepository } from './telegram-bindings'

const ALICE = asUserId('user:alice')
const BOB = asUserId('user:bob')

let db: ReturnType<typeof openDatabase>
let bindings: TelegramBindingsRepository

beforeEach(() => {
  // The REAL migrated schema — the primary-key claim below is a claim about
  // what the shipped migration created, so a fake would prove nothing. Opened
  // directly rather than through `SessionStore` because these tests must plant
  // rows the repository would never write.
  db = openMigratedTestDatabase()
  bindings = new TelegramBindingsRepository(db)
})

const binding = (
  userId: typeof ALICE,
  chatId: string,
  boundAt = '2026-07-31T00:00:00.000Z',
): TelegramChatBinding => ({
  userId,
  chatId,
  boundAt,
  boundBy: { actor: { kind: 'user', id: userId }, onBehalfOf: userId },
})

/** Write a row the repository would never write, to exercise the reader. */
const rawInsert = (cols: Record<string, string | null>): void => {
  const keys = Object.keys(cols)
  db.prepare(
    `INSERT OR REPLACE INTO telegram_chat_bindings (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
  ).run(...keys.map((k) => cols[k] ?? null))
}

describe('the table round-trips a binding', () => {
  it('stores and reads back the user, the timestamp and the attribution pair', () => {
    bindings.upsert(binding(ALICE, '-1001'))
    const [row] = bindings.list()
    expect(row).toEqual(binding(ALICE, '-1001'))
  })

  it('lets one person hold many chats — the direction that is safe', () => {
    bindings.upsert(binding(ALICE, '-1001'))
    bindings.upsert(binding(ALICE, '-2002', '2026-07-31T00:01:00.000Z'))
    bindings.upsert(binding(BOB, '-3003', '2026-07-31T00:02:00.000Z'))
    expect(
      bindings
        .listForUser(ALICE)
        .map((b) => b.chatId)
        .sort(),
    ).toEqual(['-1001', '-2002'])
    expect(bindings.listForUser(BOB).map((b) => b.chatId)).toEqual(['-3003'])
  })

  it('removing a binding stops the chat resolving, with no cache to invalidate', () => {
    bindings.upsert(binding(ALICE, '-1001'))
    expect(resolveTelegramPrincipal(bindings.list(), '-1001').ok).toBe(true)
    bindings.remove('-1001')
    expect(resolveTelegramPrincipal(bindings.list(), '-1001')).toEqual({
      ok: false,
      reason: 'unbound',
    })
  })
})

describe('ONE ROW PER CHAT is enforced by the database, not by convention', () => {
  it('a second binding for the same chat REPLACES the first rather than joining it', () => {
    // The property the resolver's `ambiguous` arm exists to survive: with two
    // rows possible, resolution would have to elect a winner, and whoever can
    // cause the second row would be the one electing.
    bindings.upsert(binding(ALICE, '-1001'))
    bindings.upsert(binding(BOB, '-1001', '2026-07-31T00:05:00.000Z'))

    const rows = bindings.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.userId).toBe(BOB)
    // Rebinding re-stamps WHO took the chat — after a rebind this row is the
    // only record of it.
    expect(rows[0]?.boundBy.onBehalfOf).toBe(BOB)
  })

  it('a raw INSERT cannot create a second row for one chat either', () => {
    // Asserted against SQLite rather than against the repository, because the
    // repository's `OR REPLACE` would satisfy the test above even with no
    // constraint at all.
    bindings.upsert(binding(ALICE, '-1001'))
    expect(() =>
      db
        .prepare(
          'INSERT INTO telegram_chat_bindings (chat_id, user_id, bound_at, actor_kind, actor_id, on_behalf_of) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('-1001', BOB, '2026-07-31T00:05:00.000Z', 'user', BOB, BOB),
    ).toThrow()
    // …and the incumbent is untouched.
    expect(bindings.list()[0]?.userId).toBe(ALICE)
  })
})

describe('an unreadable row DENIES rather than resolving to a guess', () => {
  // Each case plants ONE bad row beside a good one, so "the reader returned
  // nothing" cannot be what makes the assertion pass.
  const good = () => bindings.upsert(binding(ALICE, '-1001'))

  it('drops a row whose actor kind this build has never heard of', () => {
    good()
    rawInsert({
      chat_id: '-2002',
      user_id: BOB,
      bound_at: '2026-07-31T00:00:00.000Z',
      actor_kind: 'sorcerer',
      actor_id: BOB,
      on_behalf_of: BOB,
    })
    expect(bindings.list().map((b) => b.chatId)).toEqual(['-1001'])
    expect(resolveTelegramPrincipal(bindings.list(), '-2002')).toEqual({
      ok: false,
      reason: 'unbound',
    })
  })

  it('drops a row with an empty user id', () => {
    good()
    rawInsert({
      chat_id: '-2002',
      user_id: '',
      bound_at: '2026-07-31T00:00:00.000Z',
      actor_kind: 'user',
      actor_id: BOB,
      on_behalf_of: BOB,
    })
    expect(bindings.list().map((b) => b.chatId)).toEqual(['-1001'])
  })

  it('drops a `user` row with no actor id, rather than inventing one', () => {
    good()
    rawInsert({
      chat_id: '-2002',
      user_id: BOB,
      bound_at: '2026-07-31T00:00:00.000Z',
      actor_kind: 'user',
      actor_id: null,
      on_behalf_of: BOB,
    })
    expect(bindings.list().map((b) => b.chatId)).toEqual(['-1001'])
  })

  it('ADMITS a system-attributed row — the reader is not refusing everything', () => {
    // The positive control for the three refusals above. Without it, a reader
    // that dropped every row it did not itself write would pass all of them.
    good()
    rawInsert({
      chat_id: '-2002',
      user_id: BOB,
      bound_at: '2026-07-31T00:00:00.000Z',
      actor_kind: 'system',
      actor_id: 'binding-ceremony',
      on_behalf_of: BOB,
    })
    const rows = bindings.list()
    expect(rows.map((b) => b.chatId).sort()).toEqual(['-1001', '-2002'])
    expect(resolveTelegramPrincipal(rows, '-2002')).toEqual({ ok: true, userId: BOB })
  })
})
