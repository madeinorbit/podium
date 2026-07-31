/**
 * The binding ceremony's model half (POD-1080).
 *
 * EVERY SUITE IN THIS RUN IS ASKED THE SAME QUESTION: what environmental fact
 * does the REFUSING arm depend on, and can this test produce it? Here the
 * refusing arms are `unbound` (no row), `ambiguous` (two rows) and an expired
 * mint — all three are plain data this file constructs directly, so all three
 * fire. The arm that could NOT fire is the one worth naming: there is no
 * "wrong user" arm, because the resolver has no user input to be wrong about.
 *
 * The positive controls matter as much: a resolver that refused everything would
 * satisfy every denial assertion below, so each refusal is paired with an
 * allowance that must SUCCEED on the same code path.
 */

import { describe, expect, it } from 'vitest'
import { Attribution } from '../fields/attribution'
import { PerUserSingletonKey } from '../fields/per-user-key'
import { UserIdField } from '../ids'
import { asUserId } from '../ids/brands'
import {
  redeemTelegramClaimCode,
  resolveTelegramPrincipal,
  TelegramChatBinding,
  TelegramChatIdField,
  TelegramClaimCode,
  telegramClaimCodeIsLive,
} from './telegram-binding'

const ALICE = asUserId('user:alice')
const BOB = asUserId('user:bob')

const binding = (userId: typeof ALICE, chatId: string): TelegramChatBinding => ({
  userId,
  chatId,
  boundAt: '2026-07-31T00:00:00.000Z',
  boundBy: { actor: { kind: 'user', id: userId }, onBehalfOf: userId },
})

const mint = (over: Partial<TelegramClaimCode> = {}): TelegramClaimCode => ({
  code: 'PODIUM1234ABCD',
  userId: ALICE,
  createdAt: '2026-07-31T00:00:00.000Z',
  expiresAt: '2026-07-31T00:10:00.000Z',
  ...over,
})

describe('the schemas compose the shared fragments by IDENTITY, not by restatement', () => {
  // POD-305: a restated schema is byte-identical on the wire and fails only an
  // identity assertion. Asserted per member rather than on the object.
  it('keys the binding on the ONE UserIdField instance', () => {
    expect(TelegramChatBinding.shape.userId).toBe(UserIdField)
    expect(TelegramChatBinding.shape.userId).toBe(PerUserSingletonKey.shape.userId)
  })

  it('carries the ONE Attribution instance for `boundBy`', () => {
    expect(TelegramChatBinding.shape.boundBy).toBe(Attribution)
  })

  it('spells the chat id once, and both schemas use that spelling', () => {
    expect(TelegramChatBinding.shape.chatId).toBe(TelegramChatIdField)
  })

  it('stamps the mint with the same UserIdField — the field the ceremony carries', () => {
    expect(TelegramClaimCode.shape.userId).toBe(UserIdField)
  })

  // Non-vacuity for the four assertions above: prove the instrument can say NO.
  it('a restated field is NOT the shared instance', () => {
    expect(UserIdField.describe('a copy')).not.toBe(UserIdField)
  })

  it('refuses an empty chat id, so an empty id can never be STORED and never MATCH', () => {
    expect(TelegramChatIdField.safeParse('').success).toBe(false)
    expect(TelegramChatIdField.safeParse('-1001234').success).toBe(true)
  })
})

describe('resolution fails closed — ADR 3 Amendment 1 D22.2', () => {
  it('resolves a bound chat to the user in the binding (the POSITIVE control)', () => {
    const result = resolveTelegramPrincipal([binding(ALICE, '-1001')], '-1001')
    expect(result).toEqual({ ok: true, userId: ALICE })
  })

  it('refuses an unknown chat rather than defaulting to any user', () => {
    const result = resolveTelegramPrincipal([binding(ALICE, '-1001')], '-9999')
    expect(result).toEqual({ ok: false, reason: 'unbound' })
  })

  it('refuses when the table holds NO bindings at all', () => {
    expect(resolveTelegramPrincipal([], '-1001')).toEqual({ ok: false, reason: 'unbound' })
  })

  it('refuses an empty chat id even against a populated table', () => {
    expect(resolveTelegramPrincipal([binding(ALICE, '-1001')], '')).toEqual({
      ok: false,
      reason: 'unbound',
    })
  })

  it('REFUSES TO CHOOSE when two bindings name one chat, rather than electing one', () => {
    // The arm the union exists for. `find()` would return Alice here and read as
    // correct; every tie-break rule is an impersonation primitive.
    const result = resolveTelegramPrincipal([binding(ALICE, '-1001'), binding(BOB, '-1001')], '-1001')
    expect(result).toEqual({ ok: false, reason: 'ambiguous' })
  })

  it('still resolves OTHER chats while one chat is ambiguous', () => {
    // Guards against a resolver that fails closed by failing at everything: the
    // ambiguity must be scoped to the ambiguous chat.
    const bindings = [binding(ALICE, '-1001'), binding(BOB, '-1001'), binding(BOB, '-2002')]
    expect(resolveTelegramPrincipal(bindings, '-2002')).toEqual({ ok: true, userId: BOB })
  })

  it('distinguishes the two users it resolves — the suite is not asserting one constant', () => {
    // POD-351's shape: a suite where every case resolves to the same identity
    // would pass against an implementation that ignores the binding entirely.
    const bindings = [binding(ALICE, '-1001'), binding(BOB, '-2002')]
    expect(resolveTelegramPrincipal(bindings, '-1001')).toEqual({ ok: true, userId: ALICE })
    expect(resolveTelegramPrincipal(bindings, '-2002')).toEqual({ ok: true, userId: BOB })
  })
})

describe('redemption takes the user from the MINT and has no argument for another', () => {
  it('binds the chat to the minting user', () => {
    const result = redeemTelegramClaimCode(mint(), '-1001', '2026-07-31T00:05:00.000Z')
    expect(result).toEqual({
      userId: ALICE,
      chatId: '-1001',
      boundAt: '2026-07-31T00:05:00.000Z',
      boundBy: { actor: { kind: 'user', id: ALICE }, onBehalfOf: ALICE },
    })
  })

  it('binds to the MINT’s user even when a different user holds a binding already', () => {
    // The identity comes from the mint, not from any ambient state.
    const result = redeemTelegramClaimCode(mint({ userId: BOB }), '-1001', '2026-07-31T00:05:00.000Z')
    expect(result?.userId).toBe(BOB)
  })

  it('produces a binding that PARSES as the durable schema', () => {
    const result = redeemTelegramClaimCode(mint(), '-1001', '2026-07-31T00:05:00.000Z')
    expect(TelegramChatBinding.safeParse(result).success).toBe(true)
  })

  it('refuses an expired mint', () => {
    expect(redeemTelegramClaimCode(mint(), '-1001', '2026-07-31T00:10:00.001Z')).toBeUndefined()
  })

  it('admits a mint exactly at its expiry instant, so the boundary is stated not guessed', () => {
    expect(redeemTelegramClaimCode(mint(), '-1001', '2026-07-31T00:10:00.000Z')).toBeDefined()
  })

  it('refuses an empty chat id', () => {
    expect(redeemTelegramClaimCode(mint(), '', '2026-07-31T00:05:00.000Z')).toBeUndefined()
  })

  it('has arity 3 — there is no user parameter for a caller to thread a payload into', () => {
    // The mechanism claim, asserted rather than described: `(mint, chatId, now)`.
    // A fourth parameter would be the hole D7 forbids, and this fails the day
    // someone adds one.
    expect(redeemTelegramClaimCode.length).toBe(3)
  })

  it('liveness is a pure predicate over the mint and the caller’s clock', () => {
    expect(telegramClaimCodeIsLive(mint(), '2026-07-31T00:00:00.000Z')).toBe(true)
    expect(telegramClaimCodeIsLive(mint(), '2026-07-31T01:00:00.000Z')).toBe(false)
  })
})
