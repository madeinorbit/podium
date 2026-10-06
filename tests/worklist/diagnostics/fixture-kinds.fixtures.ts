/**
 * Synthetic harness kind for the logged-out fixture session (POD-5614).
 *
 * Spelled here, once, in the excluded fixture path: the session-pane fixture
 * needs a kind its test machine lists as logged out, and a quoted vendor
 * literal anywhere else trips the harness-vendor boundary. Values are data,
 * never behaviour. Test files may keep spelling their own literals.
 */
export const SYNTHETIC_CODEX_KIND = 'codex'
