/**
 * ANOTHER TAB OR WINDOW SWITCHED THE ACCOUNT (POD-6292, MU-12).
 *
 * Every tab and window of one origin shares the browser's storage and cookie
 * jar. When one of them signs Alice out (or signs Bob in), the others are still
 * painting Alice's world from memory, and nothing they hold tells them so until
 * their next request is refused. If Bob walks up to one of those tabs, he sees
 * Alice's data.
 *
 * So a runtime watches the saved account state that every sign-out and sign-in
 * writes. The moment it no longer names this runtime's member as the device's
 * active, signed-in account, the shell ends the runtime the same way an expired
 * session ends it. The member fence on every request (`../principal.ts`) is the
 * backstop for anything this watcher cannot see.
 */

import type { ReplicaIdentity } from '../replica/principal-storage'
import type { ServerProfile, ServerProfileState } from './server-profiles'

/**
 * Does this serialized profile state still make `identity` the device's active,
 * signed-in account? Missing, corrupt or emptied state answers no: a runtime
 * that cannot show it still holds the device must not keep painting.
 */
export function savedProfilesStillHold(
  serialized: string | null,
  identity: ReplicaIdentity,
): boolean {
  if (serialized === null) return false
  let state: Partial<ServerProfileState>
  try {
    state = JSON.parse(serialized) as Partial<ServerProfileState>
  } catch {
    return false
  }
  if (!Array.isArray(state.profiles)) return false
  const active: Partial<ServerProfile> | undefined =
    state.profiles.find((profile) => profile?.id === state.activeProfileId) ??
    (state.activeProfileId === undefined ? state.profiles[0] : undefined)
  return (
    active !== undefined &&
    active.signedOut !== true &&
    active.memberId === identity.memberId &&
    active.syncBoundaryId === identity.syncBoundaryId
  )
}

/** The window seam: `storage` events fire only for writes made by OTHER tabs. */
export interface StorageEventSource {
  addEventListener(type: 'storage', listener: (event: StorageEventLike) => void): void
  removeEventListener(type: 'storage', listener: (event: StorageEventLike) => void): void
}

export interface StorageEventLike {
  /** null when another tab cleared the whole storage area. */
  readonly key: string | null
  readonly newValue: string | null
}

/**
 * Call `onSwitched` once when another tab or window changes the saved profile
 * state under `profilesKey` so that it no longer names `identity`. Returns the
 * unsubscribe.
 */
export function watchAccountSwitch(args: {
  readonly source: StorageEventSource
  readonly profilesKey: string
  readonly identity: ReplicaIdentity
  readonly onSwitched: () => void
}): () => void {
  let fired = false
  const listener = (event: StorageEventLike) => {
    if (fired) return
    if (event.key !== null && event.key !== args.profilesKey) return
    if (event.key !== null && savedProfilesStillHold(event.newValue, args.identity)) return
    fired = true
    args.onSwitched()
  }
  args.source.addEventListener('storage', listener)
  return () => args.source.removeEventListener('storage', listener)
}
