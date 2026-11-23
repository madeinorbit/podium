/**
 * @podium/live-grants: short-lived signed grants for the live channel
 * (POD-6954 design 4.5).
 *
 * Core signs ({@link signClientGrant}, {@link signDaemonGrant}); the room and
 * the daemon verify ({@link verifyLiveGrant}) with a public key ring and ask
 * nobody. `./key-file` reads a ring from a file and picks up a rotated one
 * without a restart.
 */

export {
  CLIENT_GRANT_LIFETIME_MS,
  type ClientGrantClaims,
  DAEMON_GRANT_LIFETIME_MS,
  type DaemonGrantClaims,
  type GrantBinding,
  LIVE_GRANT_ACTIONS,
  LIVE_GRANT_REFUSALS,
  type LiveGrantAction,
  type LiveGrantClaims,
  type LiveGrantKind,
  type LiveGrantRefusal,
  MAX_GRANT_IDS,
  refreshAtOf,
  type SignedLiveGrant,
} from './claims'
export {
  deriveKeyId,
  type LiveGrantKey,
  LiveGrantKeyError,
  LiveGrantKeyRing,
  mintLiveGrantKey,
  parseLiveGrantKeyRing,
} from './keys'
export {
  LiveGrantSigningUnavailable,
  type SignOptions,
  signClientGrant,
  signDaemonGrant,
  signLiveGrant,
} from './sign'
export {
  MAX_ISSUE_SKEW_MS,
  VerifiedClientGrant,
  VerifiedDaemonGrant,
  type VerifiedLiveGrant,
  type VerifyOptions,
  type VerifyResult,
  verifyLiveGrant,
} from './verify'
export { MAX_TOKEN_CHARS, TOKEN_PREFIX } from './wire'
