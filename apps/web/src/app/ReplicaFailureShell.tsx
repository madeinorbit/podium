import type { JSX } from 'react'
import { UpdatesProvider } from '@/features/updates/updates-context'
import type { ReplicaFailure } from '@/lib/replica-failure'
import { ReplicaFailureScreen } from './ReplicaFailureScreen'

/**
 * Failures where the person may well be signed in and the server may answer
 * update reads: the boot stalled, sync could not be read, this browser's storage
 * would not open, the server is still starting, or the cause is unknown.
 * Before sign-in (no session, no account, an authentication route that failed)
 * and offline, the screen stays as it is.
 */
const SIGNED_IN_FAILURES: ReadonlySet<ReplicaFailure['kind']> = new Set([
  'boot-stalled',
  'sync-invalid',
  'replica-blocked',
  'server-starting',
  'unknown',
])

export function showsUpdatePanel(cause: ReplicaFailure): boolean {
  return SIGNED_IN_FAILURES.has(cause.kind)
}

/**
 * The failed boot gate's screen, with the update panel for a signed-in person
 * (POD-6683). A replica that will not open is sync broken, and an update is
 * often how a broken server is fixed; the panel reads over plain HTTP and needs
 * neither the replica nor the store. It shows only what the server answers to
 * this person's update reads.
 */
export function ReplicaFailureShell({
  cause,
  detail,
  httpOrigin,
}: {
  cause: ReplicaFailure
  detail: string
  httpOrigin: string
}): JSX.Element {
  const screen = <ReplicaFailureScreen cause={cause} detail={detail} httpOrigin={httpOrigin} />
  if (!showsUpdatePanel(cause)) return screen
  return <UpdatesProvider httpOrigin={httpOrigin}>{screen}</UpdatesProvider>
}
