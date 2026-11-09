import type { ClientRuntime } from '@podium/client-core/engine'
import type { SessionPaneRows } from './session-pane-schema'
import { defineSource } from './source-registry'
export const SESSION_PANE_SOURCE_KEY = 'session-pane'
/** The pane window reads UiStore's observable screen fields where they are
 *  shown; there is nothing to subscribe to. */
export class SessionPaneSource {
  private readonly source = defineSource({
    readById: (_entity: string, _id: string) => this.window,
    release: () => {},
  })
  private readonly window: SessionPaneRows['sessionPaneWindow']
  constructor(runtime: Pick<ClientRuntime, 'ui'>) {
    this.window = {
      get panelMode() {
        return runtime.ui.panelMode
      },
      get dockShells() {
        return runtime.ui.dockShells
      },
    }
  }
  read(entity: 'sessionPaneWindow', id: string): SessionPaneRows['sessionPaneWindow'] | undefined {
    return this.source.read(entity, id) as SessionPaneRows['sessionPaneWindow'] | undefined
  }
  dispose(): void {
    this.source.dispose()
  }
}
