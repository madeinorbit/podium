/** The old cookie name, retained for the sign-in carry-over. */
export const SESSION_COOKIE = 'podium_session'

/** Shared identity's signed, HttpOnly device sign-in cookies. */
export const LOCAL_DEVICE_SIGN_IN_COOKIE = 'podium.session_token'
export const SECURE_DEVICE_SIGN_IN_COOKIE = '__Secure-podium.session_token'

export const deviceSignInCookieName = (scheme: string): string =>
  scheme === 'https:' ? SECURE_DEVICE_SIGN_IN_COOKIE : LOCAL_DEVICE_SIGN_IN_COOKIE
