/**
 * THE TELEGRAM CHAT BINDING — the ceremony that gives an external chat id a
 * PODIUM USER, and the resolver that refuses when it has none (POD-1080).
 *
 * ADR 3 Amendment 1 D22, and ADR 1's matrix row `telegram-chat-binding`
 * (`perUserState`, keyed `(userId, chatId)`, `secret: 'preference'`,
 * `offline: 'online-only'`).
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS SHAPE EXISTS TO SOLVE, STATED AS THE REVIEWER WILL ASK IT
 * ---------------------------------------------------------------------------
 *
 * A Telegram message arrives carrying a chat id THE SENDER CONTROLS. ADR 3 D7
 * says a principal comes from the authenticated transport ONLY and that payload
 * identity is inert — so an inbound `chatId` can never, by itself, name a
 * person. Reading a user out of it would be the payload-identity failure D7
 * forbids, wearing the hat of a routing field.
 *
 * The answer is that the chat id is not the assertion. The assertion was made
 * EARLIER, on an authenticated transport, when a logged-in principal minted a
 * {@link TelegramClaimCode} and the mint STAMPED THAT PRINCIPAL'S USER INTO IT.
 * The claimant then presents the code out-of-band, in the chat. Redemption
 * copies the user from the MINT — never from the message — and writes a
 * {@link TelegramChatBinding}. So the answer to "what stops someone claiming
 * another person's Telegram id" is a property of the MECHANISM: the only way to
 * produce a binding naming user U is to hold a code minted by an authenticated
 * session of U, and that code is a short-lived single-use secret.
 *
 * This mirrors machine pairing exactly (`machines.pairingCode`, POD-384; owner
 * flowing from the pairer, POD-1079): *the redeemer supplies everything else and
 * must not supply this*. {@link redeemTelegramClaimCode} therefore takes no user
 * argument — not "ignores one", TAKES NONE — because a parameter that exists is
 * a parameter a caller can thread a chat-supplied value into.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT MAKE TRUE, STATED SO NOBODY READS IT AS DONE
 * ---------------------------------------------------------------------------
 *
 * The MECHANISM is trustworthy; the BINDING it produces today is only as
 * trustworthy as the transport that minted the code, and that transport is one
 * shared password (`packages/runtime/src/auth-store.ts`,
 * `CLIENT_PRINCIPAL_GRADE === 'device'`). So on today's builds every mint stamps
 * the same first admin, and the honest statement is "this instance has one
 * human, and their chat is bound to them" — not "chats are bound per person".
 * The server-side mint site calls `deviceGradeSoleOwner()` for exactly that
 * reason and `bun run audit:machine-grants` counts it; when per-user login lands
 * (POD-315) that module is deleted and the call site becomes a compile error.
 *
 * Nothing here needs to change when it does. The user is a parameter of the mint
 * on this side of the seam already.
 */

import { z } from 'zod'
import { Attribution } from '../fields/attribution'
import { PerUserSingletonKey } from '../fields/per-user-key'
import { UserIdField } from '../ids'
import type { UserId } from '../ids/brands'

/**
 * An external chat id, as ONE definition both schemas below compose.
 *
 * `.min(1)` and not `z.string()`, because the empty string is what a missing
 * chat id looks like after a `?? ''` — and an empty id that could be STORED is
 * an id an empty inbound message could later MATCH. Compare
 * `notifications.telegramChatId`, which is `z.string().default('')`: that field
 * is outbound ROUTING config where empty means "not configured", a legitimate
 * state. This one is half of an authentication record and has no such state.
 */
export const TelegramChatIdField = z.string().min(1)

/**
 * THE MINTED CLAIM CODE — credential material, and the only place a user id
 * enters the ceremony.
 *
 * ADR 9 D3's `secrets` class: this is a preimage. It is never replicated, never
 * wired, and never logged; `telegram.claimCode`'s contract carries the redaction
 * declaration for its output. The row is short-lived and single-use by
 * construction — {@link telegramClaimCodeIsLive} is a pure predicate over
 * `expiresAt`, and redemption consumes the mint.
 */
export const TelegramClaimCode = z.object({
  /** The bearer secret the claimant presents in the chat. */
  code: z.string().min(1),
  /**
   * WHOSE IDENTITY THIS CODE CONFERS — stamped at mint from the transport
   * principal (ADR 3 D7), carried opaquely to redemption, and never re-supplied
   * there. This is the field the whole ceremony exists to carry.
   */
  userId: UserIdField,
  createdAt: z.string(),
  expiresAt: z.string(),
})
export type TelegramClaimCode = z.infer<typeof TelegramClaimCode>

/**
 * THE DURABLE BINDING — `(userId, chatId)`, the matrix row's key.
 *
 * It composes {@link PerUserSingletonKey} and NOT `perUserKey(...)`, for the
 * reason `ClientSessionAggregate` gives for the same choice: `perUserKey` keys
 * state a person holds ABOUT AN ENTITY, and a Telegram chat is not a Podium
 * entity. Calling `chatId` an `entityId` to reuse the fragment would be the
 * well-typed lie the branded-id work exists to stop. The user half is still the
 * one shared `UserIdField` instance, which `telegram-binding.test.ts` pins.
 *
 * No `visibility` field, per the per-user-state rule: the class is a matrix
 * annotation on the family, never a per-row value a writer could set wrong. A
 * binding is not grantable — there is no "share my Telegram account" verb.
 */
export const TelegramChatBinding = PerUserSingletonKey.extend({
  chatId: TelegramChatIdField,
  boundAt: z.string(),
  /** WHO PERFORMED THE BINDING. The actor is the principal that redeemed; the
   *  on-behalf-of half is the human the binding names (ADR 3 Amendment 1 D17). */
  boundBy: Attribution,
})
export type TelegramChatBinding = z.infer<typeof TelegramChatBinding>

/** Is this mint still live at `now`? Pure, so the caller's clock is the caller's. */
export const telegramClaimCodeIsLive = (mint: TelegramClaimCode, now: string): boolean =>
  now <= mint.expiresAt

/**
 * WHY THE RESOLUTION REFUSED. Named, because a bare `undefined` is one `??` away
 * from a fallback identity — which is precisely the fail-open D22.2 forbids
 * ("must NEVER fall back to an operator identity").
 */
export type TelegramBindingRefusal =
  /** No binding names this chat. The ordinary case, and the fail-closed default. */
  | 'unbound'
  /**
   * TWO OR MORE bindings name this chat. Resolution REFUSES rather than picking,
   * and this arm is the reason the resolver returns a union instead of a
   * `find()`. Any tie-break rule — first row, newest row, lowest user id — is an
   * impersonation primitive: whoever can cause a second row for a chat someone
   * else holds gets to decide whether their rule or the incumbent's wins. The
   * store enforces one row per chat; this is the model-level statement of the
   * same invariant, so a corrupted or hand-edited table fails closed rather than
   * silently electing a user.
   */
  | 'ambiguous'

export type TelegramPrincipalResolution =
  | { readonly ok: true; readonly userId: UserId }
  | { readonly ok: false; readonly reason: TelegramBindingRefusal }

/**
 * RESOLVE AN INBOUND CHAT TO A USER, OR REFUSE — the total function D22.1 and
 * D22.2 describe.
 *
 * Total, pure, and given no default: there is no parameter here for a fallback
 * user, so no call site can pass one. It reads only the stored bindings and the
 * chat id, and every path that is not an exact single match is a refusal.
 */
export function resolveTelegramPrincipal(
  bindings: Iterable<TelegramChatBinding>,
  chatId: string,
): TelegramPrincipalResolution {
  const matches: TelegramChatBinding[] = []
  for (const binding of bindings) {
    if (binding.chatId === chatId) matches.push(binding)
  }
  // An empty or blank chat id can never match a stored binding, because
  // `TelegramChatIdField` refuses to store one — so this needs no separate
  // branch, and a test pins that rather than trusting the reasoning.
  if (matches.length === 0) return { ok: false, reason: 'unbound' }
  if (matches.length > 1) return { ok: false, reason: 'ambiguous' }
  const only = matches[0]
  if (!only) return { ok: false, reason: 'unbound' }
  return { ok: true, userId: only.userId }
}

/**
 * REDEEM A MINT AGAINST A CHAT ID — and note the signature.
 *
 * There is NO user parameter. The user comes from `mint.userId`, which was
 * stamped on an authenticated transport. POD-1079's rule for the pair frame is
 * the same one: *"the daemon supplies everything else and must not supply
 * this"*. A `userId` argument here would compile, read naturally, and be the
 * exact hole the ceremony exists to close — so the argument does not exist.
 *
 * Returns the binding to persist, or `undefined` when the mint has expired. The
 * caller consumes the mint either way; single-use is the caller's invariant
 * because it is a storage fact, and `audit:telegram-binding` checks it.
 */
export function redeemTelegramClaimCode(
  mint: TelegramClaimCode,
  chatId: string,
  now: string,
): TelegramChatBinding | undefined {
  if (!telegramClaimCodeIsLive(mint, now)) return undefined
  const parsedChatId = TelegramChatIdField.safeParse(chatId)
  if (!parsedChatId.success) return undefined
  return {
    userId: mint.userId,
    chatId: parsedChatId.data,
    boundAt: now,
    boundBy: { actor: { kind: 'user', id: mint.userId }, onBehalfOf: mint.userId },
  }
}
