import type { ClientRuntime } from '@podium/client-core/engine'
import { observable, runInAction } from 'mobx'
import type { SessionPaneRows } from './session-pane-schema'

export const SESSION_PANE_SOURCE_KEY = 'session-pane'

/** A borrowed controls projection on the app-owned runtime, with no session
 * collection, transcript, replica, mutation or outbox of its own. */
export class SessionPaneSource {
  private readonly value = observable.box<SessionPaneRows['sessionPaneWindow'] | undefined>(
    undefined,
    { deep: false },
  )
  private readonly stop: () => void
  private disposed = false
  constructor(runtime: Pick<ClientRuntime, 'readLocal' | 'onLocals'>) {
    const update = () => {
      if (this.disposed) return
      const panelMode = runtime.readLocal('panelMode'),
        dockShells = runtime.readLocal('dockShells'),
        reposLoaded = runtime.readLocal('reposLoaded')
      const previous = this.value.get()
      if (
        previous &&
        previous.panelMode === panelMode &&
        previous.dockShells === dockShells &&
        previous.reposLoaded === reposLoaded
      )
        return
      runInAction(() => this.value.set({ panelMode, dockShells, reposLoaded }))
    }
    update()
    // Keyed (POD-5433): only these four locals wake the pane window.
    this.stop = runtime.onLocals(['panelMode', 'dockShells', 'reposLoaded'], update)
  }
  read(_entity: 'sessionPaneWindow', _id: string) {
    return this.value.get()
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    runInAction(() => this.value.set(undefined))
  }
}
