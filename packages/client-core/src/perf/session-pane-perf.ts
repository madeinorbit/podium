import { recordSliceDerivation } from './store-stats'

/** Count actual legacy pane reads under the existing runtime's diagnostics.
 * No payloads or clocks; disabled diagnostics have no work beyond this call. */
export function legacySessionPaneRead<T>(owner: object, name: string, read: () => T): T {
  recordSliceDerivation(owner, `sessionPane.${name}`)
  return read()
}
