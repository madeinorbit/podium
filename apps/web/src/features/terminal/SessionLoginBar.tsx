/**
 * "CLAUDE ISN'T LOGGED IN": the bar for a session whose harness runs on the
 * machine's own login and that login is out (`session.condition`). A session
 * on a credential never gets it (POD-7062); its credential's health speaks
 * through the credential notice instead.
 */

import { panelLabel, type TerminalOutlook } from '@podium/client-core/values'
import type { AgentKind } from '@podium/model'
import type { JSX } from 'react'

export function SessionLoginBar({
  agentKind,
  terminalOutlook,
}: {
  agentKind: AgentKind
  terminalOutlook: TerminalOutlook
}): JSX.Element {
  return (
    <div
      role="status"
      className="flex flex-none items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
    >
      <strong>{panelLabel(agentKind)} isn&apos;t logged in</strong>
      <span>
        {terminalOutlook === 'none'
          ? 'Open a sign-in terminal to authenticate, then retry here.'
          : 'Run its login command in this pane to continue.'}
      </span>
    </div>
  )
}
