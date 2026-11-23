import { machineViewsFromWire } from '@podium/client-core/values'
import { Laptop } from 'lucide-react'
import { type JSX, useContext } from 'react'
import { Button } from '@/components/ui/button'
import { AdminViewerContext, useAdminSections } from '@/features/settings/admin-viewer'
import { useSettingsCatalog } from '@/features/settings/readers'
import { useSettingsClient } from '@/features/settings/stable-access'

/**
 * Whether the workspace should offer this member the machine step instead of
 * the task composer (POD-6882): they joined a server someone else set up, and
 * there is no machine they may run agents on. Without one, the composer's
 * Launch can only be refused.
 */
export function useNeedsMemberMachine(): boolean {
  // The shell's one shared answer (AppShell's SharedAdminViewer). Without it,
  // nothing has said this viewer joined someone else's server: no step, and no
  // request of its own.
  const viewer = useContext(AdminViewerContext)
  const { machines } = useSettingsCatalog()
  if (viewer?.status !== 'ready' || viewer.capabilities?.setUpServer !== false) return false
  return machineViewsFromWire(machines).every((view) => view.availability === 'unauthorized')
}

/**
 * THE MEMBER-SIZED MACHINE STEP (POD-6882).
 *
 * A member who joined an existing workspace is not setting up a server, so the
 * first-run wizard (where Podium runs, VPS install) is not theirs. What they
 * may still lack is a machine of their own. This step sits in the workspace,
 * so the sidebar, Settings and sign-out stay where they always are.
 *
 * What it offers follows what the server lets this member do
 * (`capabilities.addMachine`, POD-6883): someone who may add a machine gets the
 * install command in Settings › Machines; anyone else is told that an admin
 * adds machines, and where theirs will appear.
 */
export function MemberMachineStep(): JSX.Element {
  const viewer = useAdminSections()
  const { setView, setSettingsTab } = useSettingsClient()
  const mayAddMachines = viewer.capabilities?.addMachine === true
  const openMachines = (): void => {
    setSettingsTab('machines')
    setView('settings')
  }

  return (
    <div
      data-testid="member-machine-step"
      className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-10 font-sans"
    >
      <section aria-labelledby="member-machine-title" className="w-full max-w-[460px]">
        <Laptop size={20} className="text-text-dim" aria-hidden="true" />
        <h2 id="member-machine-title" className="mt-3 text-[17px] font-semibold text-text-strong">
          Add your machine
        </h2>
        {mayAddMachines ? (
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
            Agents run on a computer you add to this workspace. In Settings › Machines, choose Add a
            machine, then run its one-line install command on that computer.
          </p>
        ) : (
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
            Agents run on a computer added to this workspace, and an admin adds them. Ask an admin
            to add your computer, or to let you use one that is already here. It appears in Settings
            › Machines when it is ready.
          </p>
        )}
        <Button type="button" size="sm" className="mt-5" onClick={openMachines}>
          {mayAddMachines ? 'Add a machine' : 'Open Machines'}
        </Button>
      </section>
    </div>
  )
}
