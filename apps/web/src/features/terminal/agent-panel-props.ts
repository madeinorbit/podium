import type { SessionId } from '@podium/model/browser'

export interface AgentPanelProps {
  sessionId: SessionId
  /** False when this panel is mounted but hidden (an inactive tab kept warm so
   * switching back catches up instead of wiping). Gates focus, nothing else. */
  active?: boolean
  /** True only for the active tab in the workspace's focused pane. A split
   * workspace can have several visible/active terminals, but desktop shortcut
   * commands must have exactly one recipient. */
  focused?: boolean
  /** Setup embeds the native terminal inside a dialog that already owns its title and close
   * action. Hide the ordinary workspace controls there so sign-in stays a single-purpose flow. */
  showHeader?: boolean
}
