import type { UiState } from '@podium/client-core/ui-state'
import { recordSliceDerivation } from '@podium/client-core/perf'
import { webPoolSwitch } from '@/lib/mobx-pilot'

const screen = webPoolSwitch('mobxSuperagent', 'mobxSuperagentCheck')
export const initializeSuperagentDataLayer = (ui: Pick<UiState, 'get'>): void => { screen.initialize(ui) }
export const superagentDataLayer = screen.layer
export const superagentCheckRequested = screen.checkRequested

/** The published superagent slice already records its actual derivations.
 * These counts name the remaining screen-owned legacy projections. */
export function legacySuperagentRead<T>(owner: object, name: string, read: () => T): T {
  recordSliceDerivation(owner, `superagent.${name}`)
  return read()
}
