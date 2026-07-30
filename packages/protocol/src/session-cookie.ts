/**
 * The wire-level session cookie name used by the human-client login flow
 * (apps/server/src/auth-route.ts).
 *
 * It lives in protocol rather than in apps/server because it was SHARED: the retired
 * node⇄hub dialer rode a hub-minted token as this same cookie. POD-309 deleted that
 * consumer, and the constant stays here anyway — ADR 5 D5 reserves a future node
 * credential class, and moving a wire name into one app is the kind of relocation that
 * has to be undone rather than the kind that pays for itself.
 */
export const SESSION_COOKIE = 'podium_session'
