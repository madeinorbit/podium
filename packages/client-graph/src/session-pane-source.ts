import type { ClientRuntime } from '@podium/client-core/engine'
import { action, observable } from 'mobx'
import type { SessionPaneRows } from './session-pane-schema'
import { defineSource } from './source-registry'
export const SESSION_PANE_SOURCE_KEY = 'session-pane'
export class SessionPaneSource {
  @observable private accessor version = 0
  private readonly stop: () => void
  private readonly source = defineSource({
    readById: () => this.window,
    release: () => this.stop(),
  })
  private readonly window: SessionPaneRows['sessionPaneWindow']
  constructor(runtime: Pick<ClientRuntime, 'ui' | 'readLocal' | 'onLocals'>) {
    const version = () => this.version
    this.window = {
      get panelMode() {
        return runtime.ui.panelMode
      },
      get dockShells() {
        return runtime.ui.dockShells
      },
      get reposLoaded() {
        version()
        return runtime.readLocal('reposLoaded')
      },
    }
    this.stop = runtime.onLocals(
      ['reposLoaded'],
      action(() => {
        this.version++
      }),
    )
  }
  read(entity: 'sessionPaneWindow', id: string): SessionPaneRows['sessionPaneWindow'] | undefined {
    return this.source.read(entity, id) as SessionPaneRows['sessionPaneWindow'] | undefined
  }
  dispose(): void {
    this.source.dispose()
  }
}
