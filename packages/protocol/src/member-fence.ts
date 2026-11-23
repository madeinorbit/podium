/**
 * THE MEMBER FENCE (POD-6292, MU-12).
 *
 * A browser keeps ONE cookie jar for every tab and window of an origin. When
 * Alice signs out and Bob signs in, a tab that is still bound to Alice (asleep,
 * offline, or simply not yet told) keeps Alice's runtime: her queued commands,
 * her feed cursor and her painted world. Its next request carries Bob's cookie,
 * so without a fence that tab would drain Alice's outbox AS BOB and pull Bob's
 * feed into Alice's storage namespace.
 *
 * So every principal-bound client request names the member it was opened for:
 * the {@link MEMBER_FENCE_HEADER} header on HTTP, the {@link MEMBER_FENCE_PARAM}
 * query parameter where a header cannot be set (a browser WebSocket). The server
 * REFUSES the request when the authenticated member is someone else.
 *
 * The fence can only refuse. It never selects or widens the caller: identity
 * still comes from the credential alone (ADR 3 D7), and a request without the
 * fence is judged exactly as before.
 */

export const MEMBER_FENCE_HEADER = 'x-podium-member'
export const MEMBER_FENCE_PARAM = 'podium_member'
/** The refusal body's `code`, so a client can tell it from an expired session. */
export const MEMBER_FENCE_REFUSAL = 'member-mismatch'

/** The member a request was opened for, or undefined when it carries no fence. */
export function fencedMemberOf(request: {
  readonly url: string
  readonly headers: { get(name: string): string | null }
}): string | undefined {
  const header = request.headers.get(MEMBER_FENCE_HEADER)
  if (header !== null) return header
  const query = request.url.split('#', 1)[0]?.split('?')[1]
  if (query === undefined) return undefined
  for (const pair of query.split('&')) {
    const [name, value = ''] = pair.split('=', 2)
    if (name !== MEMBER_FENCE_PARAM) continue
    try {
      return decodeURIComponent(value.replace(/\+/g, ' '))
    } catch {
      // A malformed fence names nobody it could match: refuse rather than ignore.
      return value
    }
  }
  return undefined
}

/**
 * True when a fenced request must be refused: it names a member and the
 * authenticated member is not that member. An unfenced request is never refused
 * here. A fenced request with no authenticated member is left to the ordinary
 * credential check, which answers it.
 */
export function memberFenceRefuses(
  fenced: string | undefined,
  authenticated: string | undefined,
): boolean {
  if (fenced === undefined || authenticated === undefined) return false
  return fenced !== authenticated
}
