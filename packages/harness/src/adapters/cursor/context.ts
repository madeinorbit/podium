import type { HarnessContextSection } from '../../context-types.js'
import { canonicalDriverId, unsupported } from '../../manifest.js'

/** READ: Cursor Agent 2026.07.23-e383d2b, POD-6564 report.md R6, and the
 * documented print/stream result shapes reviewed 2026-11-22. The versioned
 * negative fixtures record the sources and their limits. No completed native
 * reply, resolved Auto capacity, ACP channel or private Store decoder is claimed.
 * A future verified source replaces this declaration with the shared strategy.
 */
export const cursorContext: HarnessContextSection = {
  forDriver(driver) {
    switch (canonicalDriverId(driver)) {
      case 'generic-pty':
        return unsupported(
          'Cursor terminal transcripts expose no validated current-context usage or effective capacity; Auto/provider capacity is unknown',
        )
      case 'headless':
        return unsupported(
          'Cursor headless text and documented JSON/stream-JSON results expose no validated current-context usage or effective capacity; a model display name does not establish Auto/provider capacity',
        )
      default:
        return unsupported('No Cursor context implementation is declared for this driver')
    }
  },
}
