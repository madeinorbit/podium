/**
 * THE "SET UP AGENTS" DIALOG (POD-6858). Any harness menu, onboarding step or
 * recovery control opens it with one call:
 *
 *   import { openSetupAgents } from '@/features/setup-agents/open-setup-agents'
 *
 *   openSetupAgents({
 *     machineId,               // whose agents to show
 *     origin: 'menu',          // 'menu' | 'settings' | 'onboarding'
 *     focus: 'codex',          // optional: the harness the opener asked about (ticked, not installed)
 *     onStart: (harness) => …, // optional: "Start <harness> session" hands it back, then the dialog closes
 *   })
 *
 * `closeSetupAgents()` closes it. `SetupAgentsDialogHost` (mounted once in the
 * app shell) renders this dialog for the open request; nothing installs until
 * the person presses Install. Settings › Machine embeds the same panel
 * without this chrome (`MachineAgentSetup`).
 */

import type { MachineModel } from '@podium/client-graph'
import { here } from '@podium/client-graph/lookup'
import { observer } from '@podium/client-graph/react'
import { useShellMachines } from '@/app/shell-data'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  closeSetupAgents,
  type SetupAgentsRequest,
  setupAgentsRequest,
  switchSetupAgentsMachine,
} from './open-setup-agents'
import { type SetupAgentsMachineChoice, SetupAgentsPanel } from './SetupAgentsPanel'
import { useAgentSetupView } from './use-agent-setup-view'

export const SetupAgentsDialog = observer(function SetupAgentsDialog() {
  const request = setupAgentsRequest()
  const pool = useWorklistPool()
  const machine = request && pool ? here(pool.model('machine', request.machineId)) : undefined
  // The person's fleet; a machine they may not change shows the panel's notice.
  const machines = useShellMachines()
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && closeSetupAgents()}>
      <DialogContent
        showCloseButton={false}
        className="flex w-full max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[680px]"
      >
        <DialogTitle className="sr-only">Set up agents</DialogTitle>
        {!request ? null : machine ? (
          <OpenPanel
            key={`${request.machineId}:${request.opening}`}
            request={request}
            opening={request.opening}
            machine={machine as MachineModel}
            machines={machines}
          />
        ) : (
          <p className="m-0 p-6 text-sm text-muted-foreground" role="status">
            This machine is not available.
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
})

const OpenPanel = observer(function OpenPanel({
  request,
  opening,
  machine,
  machines,
}: {
  request: SetupAgentsRequest
  opening: number
  machine: MachineModel
  machines: readonly SetupAgentsMachineChoice[]
}) {
  const view = useAgentSetupView({
    machine,
    origin: request.origin,
    ...(request.onStart ? { onStart: request.onStart } : {}),
    ...(request.focus ? { focus: request.focus } : {}),
    opening,
  })
  return (
    <SetupAgentsPanel
      view={view}
      variant="dialog"
      onClose={closeSetupAgents}
      machines={machines}
      onSwitchMachine={switchSetupAgentsMachine}
    />
  )
})

export default SetupAgentsDialog
