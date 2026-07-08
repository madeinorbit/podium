/**
 * The wire-level session cookie name shared by the human-client login flow
 * (apps/server/src/auth-route.ts) and node⇄hub sync (@podium/sync's
 * UpstreamSync/UpstreamForwarder ride a hub-minted token as this same cookie,
 * docs/spec/node-hub-sync.md §2.1). Living in protocol lets both sides agree
 * on the name without either importing the other.
 */
export const SESSION_COOKIE = 'podium_session'
