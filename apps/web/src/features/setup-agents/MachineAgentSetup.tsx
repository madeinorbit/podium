/**
 * The Harnesses section of Settings › Machine: the "Set up agents" panel
 * embedded without dialog chrome (origin `settings`, so it hands nothing
 * back and its footer has no Done).
 */

import type { MachineModel } from '@podium/client-graph'
import { observer } from '@podium/client-graph/react'
import { SetupAgentsPanel } from './SetupAgentsPanel'
import { useAgentSetupView } from './use-agent-setup-view'

export const MachineAgentSetup = observer(function MachineAgentSetup({
  machine,
}: {
  machine: MachineModel
}) {
  const view = useAgentSetupView({ machine, origin: 'settings' })
  return (
    <section aria-label="Harnesses" className="mt-6">
      <h3 className="text-sm font-medium">Harnesses</h3>
      <p className="settings-prose mt-1 mb-3 max-w-prose">
        The agents Podium can run on this machine. Open one for its versions, updates and sign-in.
        This is the same panel as Set up agents in the harness menus.
      </p>
      {view.checking ? (
        <p className="settings-prose" role="status">
          Checking which agents {view.machineName} has…
        </p>
      ) : (
        <SetupAgentsPanel view={view} variant="embedded" />
      )}
    </section>
  )
})
