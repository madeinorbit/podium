import { observer } from '@podium/client-graph/react'
import { Plus } from 'lucide-react'
import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { useMemberRoster } from '@/lib/member-roster'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { useAdminSections } from './admin-viewer'
import { AddMachineFlow } from './machine-add'
import { MachineDetail } from './machine-detail'
import { HostThisDeviceCard, useEnableHosting } from './machine-hosting'
import { MachineListRow } from './machine-list'
import { ActiveServerMove } from './machine-server-move'
import { MachinesSettings } from './machine-view'
import { useSettingsMachines } from './readers'
import { SettingsPageActions, useSettingsFrame } from './settings-frame'
import { useSettingsClient } from './stable-access'

/** The machine list stays mounted behind pane takeovers, preserving native hosting state. */
export const MachinesPanel = observer(function MachinesPanel() {
  const machines = useSettingsMachines()
  const { trpc } = useSettingsClient()
  const { openTakeover } = useSettingsFrame()
  const viewer = useAdminSections()
  const admin = viewer.status === 'ready' && viewer.sections.includes('machines')
  const view = useMemo(() => new MachinesSettings(machines, admin), [machines, admin])
  useMemberRoster(true)
  const hosting = useEnableHosting(trpc)
  const thisMachineId = nativeDesktopBridge()?.machineId
  const alreadyPaired = machines.some((machine) => machine.id === thisMachineId)

  return (
    <section aria-label="Machines">
      {admin && (
        <SettingsPageActions>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              openTakeover({
                title: 'Add a machine',
                description:
                  'Install Podium on another computer and connect it here. It takes about a minute.',
                content: <AddMachineFlow />,
              })
            }
          >
            <Plus size={14} aria-hidden="true" />
            Add machine
          </Button>
        </SettingsPageActions>
      )}
      {!admin && (
        <p className="settings-prose mb-4">The computers you look after or may run agents on.</p>
      )}
      {hosting && !alreadyPaired && <HostThisDeviceCard hosting={hosting} />}
      <ActiveServerMove canRecover={admin} />
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {view.visible.map((machine) => (
          <MachineListRow
            key={machine.id}
            view={view.row(machine)}
            isThisMachine={machine.id === thisMachineId}
            onOpen={() =>
              openTakeover({
                title: machine.name,
                content: <MachineDetail machineId={machine.id} />,
              })
            }
          />
        ))}
        {view.visible.length === 0 && (
          <div className="px-4 py-6">
            <p className="settings-label">No machines yet</p>
            <p className="settings-prose mt-1">
              {admin
                ? 'Add a machine to run agents in this workspace.'
                : 'Ask an admin to let you run agents on one, or to add yours.'}
            </p>
          </div>
        )}
      </div>
    </section>
  )
})
