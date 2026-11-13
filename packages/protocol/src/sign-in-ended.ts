/**
 * WHY THE SERVER ENDED A CLIENT'S SOCKET (POD-6910).
 *
 * When a device's sign-in ends (signed out from the device list, or every
 * sign-in of a member) or a member loses access (removed or disabled), the
 * server closes that member's client sockets with one of these codes instead of
 * dropping them. A client reads the code only to word its sign-in screen: it
 * still asks `GET /auth/status` before it treats the sign-in as gone, so a
 * code alone never erases anything. A plain network loss carries no code.
 */
export const SIGN_IN_ENDED_CLOSE = {
  /** This device's sign-in ended. */
  signedOut: { code: 4401, reason: 'signed_out' },
  /** The member was removed from the workspace or disabled. */
  accessEnded: { code: 4403, reason: 'access_ended' },
} as const

export type SignInEndedClose = (typeof SIGN_IN_ENDED_CLOSE)[keyof typeof SIGN_IN_ENDED_CLOSE]
