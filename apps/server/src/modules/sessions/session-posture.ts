/**
 * THE ONE PLACE PRODUCT CODE CHOOSES A SESSION'S POSTURE (POD-6858,
 * docs/design/harness-session-posture.md §4.3).
 *
 * Product code states how far an agent goes without asking, in Podium's
 * words. It never names a harness mode: a native mode the person picked from
 * a harness's own served list rides through opaque, and every other session
 * runs on the default. The daemon's adapter turns the posture into flags.
 */

import { DEFAULT_SESSION_POSTURE, type SessionPosture } from '@podium/protocol'

/** The posture a session or turn runs on: the person's native pick when
 *  there is one, otherwise the default. */
export function sessionPostureFor(input: { nativeMode?: string }): SessionPosture {
  if (input.nativeMode) return { mode: { native: input.nativeMode } }
  return { mode: DEFAULT_SESSION_POSTURE.mode }
}

/**
 * The `permissionMode` word a daemon that predates posture reads for this
 * posture. Those daemons take Claude's mode words (and Grok's, Cursor's and
 * Pi's adapters compare against them), so `autonomous` is `auto`, which is
 * what the superagent sent before posture existed, and `supervised` is
 * Claude's ask-first `default`. A native pick is its own word.
 */
// LEGACY(remove-after: 2027-02): pre-posture daemons read this; removing it drops them
export function legacyPermissionModeFor(posture: SessionPosture): string {
  const mode = posture.mode
  if (typeof mode === 'object') return mode.native
  return mode === 'autonomous' ? 'auto' : 'default'
}
