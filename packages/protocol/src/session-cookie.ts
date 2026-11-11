// LEGACY(remove-after: 2027-06): old cookie name read only by carry-over; removing it requires older browsers to sign in again.
export const SESSION_COOKIE = 'podium_session'

/** Shared identity's signed, HttpOnly device sign-in cookies. */
export const LOCAL_DEVICE_SIGN_IN_COOKIE = 'podium.session_token'
export const SECURE_DEVICE_SIGN_IN_COOKIE = '__Secure-podium.session_token'

export const deviceSignInCookieName = (scheme: string): string =>
  scheme === 'https:' ? SECURE_DEVICE_SIGN_IN_COOKIE : LOCAL_DEVICE_SIGN_IN_COOKIE
