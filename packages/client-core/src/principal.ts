/**
 * THE CLIENT'S PRINCIPAL (POD-404, docs/multi-user-readiness.md §3.2).
 *
 * ---------------------------------------------------------------------------
 * WHAT A PRINCIPAL IS HERE, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 *
 * Server-side the principal is the triple `(user, device, capability)`. The
 * CLIENT half of that triple is exactly one field: the user id the authenticated
 * transport reports. The device is the client session's own cookie — the client
 * never names it — and the capability is decided at apply time by the Authority
 * and is never a client input (ADR 3 D8). So `ClientPrincipal` carries the one
 * thing the client legitimately knows and needs: WHOSE SLICE THIS IS.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT MAY COME FROM — ADR 3 D7, THE CLIENT HALF
 * ---------------------------------------------------------------------------
 *
 * "Principal from authenticated transport only. Payload identity is inert."
 *
 * The value in this object must originate from an AUTHENTICATED SERVER ANSWER
 * (today `/auth/status`'s `userId`, which the server derives from the session
 * cookie). It must NEVER be derived from:
 *
 *   - the URL (a query param or path segment naming a user),
 *   - local/session storage (a "last signed-in user" key),
 *   - a wire payload's actor/owner/origin field, or
 *   - anything the user typed.
 *
 * That is not a style rule: every one of those is attacker- or
 * bystander-controlled, and this value selects the storage namespace a slice and
 * its cursor are read from. `scripts/audit-phase2-client.ts` item 6 enforces it
 * mechanically for the whole client tree.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A VALUE AND NOT AN AMBIENT LOOKUP
 * ---------------------------------------------------------------------------
 *
 * There is deliberately no `currentPrincipal()` accessor and no module-level
 * cache in this file. The principal enters the client at exactly one place — the
 * `StoreProvider`'s `principal` prop — and flows DOWN. A module that could ask
 * for it globally could also cache it, and a cached principal is precisely the
 * value that must not survive a sign-out (POD-404 AC 3).
 */

/** The authenticated principal a client runtime is bound to. */
export interface ClientPrincipal {
  /**
   * The server-issued user id, from the authenticated transport.
   *
   * Opaque to the client: never parsed, never displayed as an identity claim
   * beyond what the server also renders, never constructed locally.
   */
  readonly userId: string
}

/**
 * The namespace key for one principal's persisted state.
 *
 * Every device-local key a client writes is rooted below this (see
 * `replica/principal-storage.ts`). Two principals therefore cannot share a
 * cursor, and a cold slice can never look caught-up because someone else's
 * cursor was left behind.
 */
export function principalKey(principal: ClientPrincipal): string {
  return principal.userId
}

/** Identity comparison for the rebind decision. Object identity is NOT enough:
 *  a platform gate that re-renders with a fresh `{ userId }` literal must not
 *  tear down and rebuild the whole client for the same person. */
export function samePrincipal(
  a: ClientPrincipal | null | undefined,
  b: ClientPrincipal | null | undefined,
): boolean {
  if (a == null || b == null) return a == null && b == null
  return a.userId === b.userId
}

/**
 * Adopt a server-supplied user id as this client's principal.
 *
 * The empty string is refused rather than normalised: an empty principal would
 * silently collapse two namespaces into one, which is the exact failure the
 * namespace exists to prevent. Callers holding a possibly-absent id must decide
 * to FAIL CLOSED (render nothing) rather than pass a placeholder here.
 */
export function asClientPrincipal(userId: string): ClientPrincipal {
  if (userId.length === 0) {
    throw new Error(
      'a client principal needs an authenticated user id; an unauthenticated client must fail closed, not adopt a placeholder',
    )
  }
  return { userId }
}
