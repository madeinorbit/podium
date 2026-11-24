import { createLogger } from '@podium/logger'
import { randomUUID } from '../id'

/** Random for this page/native runtime. Never persisted or derived from identity.
 * A reload gets a new key; an in-place socket or replica recovery keeps it. */
export const clientRecoveryId = randomUUID()

const log = createLogger('client-core:screen-recovery').child({ clientRecoveryId })

/** One visible screen opening. Call after render commits, and replace on navigation.
 * Only readiness transitions are logged; screen/record ids and contents stay out. */
export function createScreenReadinessDiagnostic(
  screen: 'flight-deck',
): (ready: boolean, refreshing?: boolean) => void {
  const screenOpeningId = randomUUID()
  let previous: boolean | undefined
  let previousRefreshing: boolean | undefined
  let wasLoaded = false
  return (ready, refreshing = false) => {
    if (ready === previous && refreshing === previousRefreshing) return
    log[wasLoaded && !ready ? 'warn' : 'info']('screen readiness changed', {
      screen,
      screenOpeningId,
      ready,
      refreshing,
      wasLoaded,
      loadedToLoading: wasLoaded && !ready,
    })
    previous = ready
    previousRefreshing = refreshing
    wasLoaded ||= ready
  }
}
