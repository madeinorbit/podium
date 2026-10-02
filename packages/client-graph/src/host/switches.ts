import type { UiState } from '@podium/client-core/ui-state'

// TEMPORARY: per-screen pool switches. When every screen is default-on, delete
// this file, each app's switch storage and the screens' initialize/enabled.

/** Where an app keeps its pool switches. The web reads URL overrides over the
 * shared device setting; mobile reads its own settings store. */
export interface PoolSwitchStorage {
  /** A per-screen value: '1'/'true' forces on, '0'/'false' forces off; a
   * check key requests the startup side-by-side check with '1'. */
  get(key: string): string | null | undefined
  /** The shared device setting every screen falls back to, default off. Read
   * only when the screen has no override. */
  device(): boolean
}

export type PoolDataLayer = 'legacy' | 'pool'

export interface PoolSwitch {
  /** Latches once per app load: principal rebuilds and later edits keep the
   * first answer, and a reload applies a new one. Returns the storage it read,
   * or undefined when this switch had already latched. */
  initialize(ui: Pick<UiState, 'get'>): PoolSwitchStorage | undefined
  layer(): PoolDataLayer
  /** One startup comparison, only with the switch on. */
  checkRequested(): boolean
}

/** An app supplies its storage once; each screen then declares its switch key
 * and optional check key. */
export function poolSwitches(storage: (ui: Pick<UiState, 'get'>) => PoolSwitchStorage) {
  return (key: string, checkKey?: string): PoolSwitch => {
    let startup: PoolDataLayer | undefined
    let check = false
    return {
      initialize(ui) {
        if (startup !== undefined) return undefined
        const source = storage(ui)
        const value = source.get(key)
        const on =
          value === '1' || value === 'true'
            ? true
            : value === '0' || value === 'false'
              ? false
              : source.device()
        startup = on ? 'pool' : 'legacy'
        check = on && checkKey !== undefined && source.get(checkKey) === '1'
        return source
      },
      layer: () => startup ?? 'legacy',
      checkRequested: () => check,
    }
  }
}
