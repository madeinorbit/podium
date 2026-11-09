import type { UiStore } from '@podium/client-core/ui'
import { reaction } from 'mobx'
import type { LocalsSourceHandle } from './locals-source'
import type { LocalsKey, SliceLocals } from './slice-types'
export interface LocalsEngine {
  readonly ui: UiStore
}
export function localsOfEngine(engine: LocalsEngine): SliceLocals {
  return {
    get selectedIssueId() {
      return engine.ui.selectedIssueId
    },
  }
}
export function createEngineLocals(engine: LocalsEngine): LocalsSourceHandle {
  const stats = {
    notifications: 0,
    keys: { selectedIssueId: 0, selectedIssueWasFolded: 0, coarseNow: 0 },
    flushes: 0,
    reset() {
      this.notifications = 0
      this.flushes = 0
      this.keys = { selectedIssueId: 0, selectedIssueWasFolded: 0, coarseNow: 0 }
    },
  }
  const listeners = new Set<(keys: ReadonlySet<LocalsKey>) => void>()
  const stop = reaction(
    () => engine.ui.selectedIssueId,
    () => {
      stats.notifications++
      stats.keys.selectedIssueId++
      for (const notify of listeners) notify(new Set(['selectedIssueId']))
    },
  )
  const value = localsOfEngine(engine)
  return {
    source: {
      get: () => value,
      subscribe(notify) {
        listeners.add(notify)
        return () => listeners.delete(notify)
      },
    },
    stats,
    flush: () => null,
    dispose() {
      stop()
      listeners.clear()
    },
  }
}
