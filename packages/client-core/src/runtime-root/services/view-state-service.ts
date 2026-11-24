import type { SessionId } from '@podium/model'
import { markSwitch } from '../../perf/switch-trace'
import type { SocketHub } from '../../socket-transport'
import { focusedPaneSession, type ScreenState, visibleScreenSessions } from '../../ui/state'
import type { UserFocus } from '../../ui/types'
import type { ConnectionService } from '../connection/connection-service'
import { ServiceLifetime } from './lifetime'
import { observeNavigation } from './observe-navigation'

export interface ViewStatePorts {
  state(): ScreenState
  hub: Pick<SocketHub, 'setViewState' | 'setVisible'>
  connection: Pick<ConnectionService, 'visibility' | 'onVisibilityChange'>
  /** Route-owned focus on a phone (POD-2451): the top screen's session, and no
   *  dock. undefined keeps the desktop workspace and dock. */
  screenFocus?(): UserFocus | null | undefined
  /** The top screen's rendered mode, transient: it never changes the saved
   *  panel choice. undefined uses the saved mode. */
  screenMode?(): 'chat' | 'native' | undefined
}
export class ViewStateService {
  private readonly lifetime = new ServiceLifetime()
  constructor(private readonly ports: ViewStatePorts) {}
  private isVisible(): boolean {
    return this.ports.connection.visibility.isVisible()
  }
  start(): void {
    if (!this.lifetime.start()) return
    this.lifetime.add(
      observeNavigation(
        () => this.ports.state().navigation,
        () => {
          const state = this.ports.state()
          const focus = this.ports.screenFocus?.()
          const visible = [
            ...visibleScreenSessions(state, focus),
            ...(focus === undefined ? [state.dockVisibleSession] : []),
          ].filter((id) => id != null)
          return [
            visible,
            focusedPaneSession(state, focus),
            visible.map((id) => this.ports.screenMode?.() ?? state.panelMode[id] ?? 'native'),
          ]
        },
        () => this.reportViewState(),
      ),
    )
    this.lifetime.add(this.ports.connection.onVisibilityChange(() => this.reportVisibility()))
    this.reportVisibility()
  }
  private reportVisibility(): void {
    if (!this.lifetime.active) return
    this.ports.hub.setVisible(this.isVisible())
    this.reportViewState()
  }
  stop(): void {
    this.lifetime.stop()
  }
  dispose(): void {
    this.lifetime.dispose()
  }
  /** Report which sessions this client renders (`visible`) and which one has
   *  input focus (`focused`) so the server can prioritize PTY relay for them.
   *  While the tab is hidden we report nothing — a backgrounded client isn't
   *  watching anything.
   *
   *  Both come from the SAME leaf walk `userFocus` uses. They used to be
   *  recomputed inline from `paneA`/`paneB`/`split`, which agreed with it for
   *  two panes and diverged for three: the third pane's session was rendered,
   *  reported to nobody, and starved of relay priority. */
  reportViewState(): void {
    const st = this.ports.state()
    const tabVisible = this.isVisible()
    const focus = this.ports.screenFocus?.()
    // The dock's shell (#23) renders OUTSIDE the panes — without reporting it
    // here the server's viewVisible gate drops its resizes and the terminal
    // stays pinned to the spawn-default 80×24.
    const visible = tabVisible
      ? [
          ...new Set(
            [
              ...visibleScreenSessions(st, focus),
              ...(focus === undefined ? [st.dockVisibleSession] : []),
            ].filter((x): x is SessionId => x != null),
          ),
        ]
      : []
    const focused = tabVisible ? focusedPaneSession(st, focus) : null
    // Rendered mode (native/chat) for each visible session — default 'native'
    // until its AgentPanel reports its effective mode.
    const modes: Record<string, 'native' | 'chat'> = {}
    for (const sid of visible)
      modes[sid] = this.ports.screenMode?.() ?? st.panelMode[sid] ?? 'native'
    this.ports.hub.setViewState(visible, focused, modes)
    // Switch-latency trace [POD-701]: stamp when the view-state report carrying
    // the traced session went out (markSwitch no-ops for untraced sessions).
    for (const sid of visible) markSwitch(sid, 'viewstate:sent')
  }
}
