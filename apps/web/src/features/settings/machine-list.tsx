import { hostMemoryView } from '@podium/client-core/values'
import { observer } from '@podium/client-graph/react'
import { Server } from 'lucide-react'
import { usePoolHostAggregate } from '@/app/header-data'
import { Badge } from '@/components/ui/badge'
import { formatDisplayedVersion } from '@/lib/machine-version-skew'
import { useMemberRoster } from '@/lib/member-roster'
import { MachineStatus } from './machine-status'
import type { SettingsMachine } from './machine-view'

export { MachineStatus } from './machine-status'

import { EntityRow } from './sections/shared'

/** Why a `plain` machine gets no credentials, and the two ways out. */
export const UNENCRYPTED_MACHINE_NOTE =
  'Its connection is not encrypted, so credentials are not sent to it. Connect it over wss, ' +
  'or have an admin add its network to Trusted networks.'

export const MachineCustodianName = observer(function MachineCustodianName({
  view,
  capitalized = false,
}: {
  view: SettingsMachine
  capitalized?: boolean
}) {
  const roster = useMemberRoster()
  const machine = view.machine
  if (machine.unowned === true || machine.custodian === null) return <>Nobody</>
  if (
    machine.owned === true ||
    (machine.custodian && machine.custodian === roster?.currentMemberId)
  ) {
    return <>{capitalized ? 'You' : 'you'}</>
  }
  return <>{roster?.nameOf(machine.custodian) ?? 'another member'}</>
})

const MachineSummary = observer(function MachineSummary({ view }: { view: SettingsMachine }) {
  const aggregate = usePoolHostAggregate(view.machine.id)
  const metrics = view.machine.metrics
  const pct = metrics ? hostMemoryView(metrics).pct : null
  return (
    <span className="settings-micro mt-1 block text-muted-foreground">
      {aggregate.count} {aggregate.count === 1 ? 'session' : 'sessions'}
      {' · '}memory {pct === null ? '—' : `${pct}%`}
      {' · '}
      <span className="font-mono">
        {view.machine.appVersion
          ? formatDisplayedVersion(view.machine.appVersion)
          : 'Version not reported'}
      </span>
    </span>
  )
})

export const MachineListRow = observer(function MachineListRow({
  view,
  isThisMachine,
  onOpen,
}: {
  view: SettingsMachine
  isThisMachine: boolean
  onOpen: () => void
}) {
  const machine = view.machine
  const role = [view.runsServer ? 'Server' : null, isThisMachine ? 'this computer' : null]
    .filter(Boolean)
    .join(' · ')
  return (
    <EntityRow
      leading={<Server size={18} aria-hidden="true" />}
      title={machine.name}
      pills={
        <>
          {role && (
            <Badge variant="outline" className="font-normal">
              {role}
            </Badge>
          )}
          {machine.unowned === true && <Badge variant="warning">Nobody looks after it</Badge>}
          {view.unencrypted && <Badge variant="warning">Not encrypted</Badge>}
        </>
      }
      subtitle={
        <>
          <span className="settings-prose block">
            {machine.unowned === true ? (
              'Agents cannot run here until an admin adopts it'
            ) : (
              <>
                Looked after by <MachineCustodianName view={view} />
              </>
            )}
          </span>
          {view.unencrypted && (
            <span className="settings-micro mt-1 block text-warning">
              {UNENCRYPTED_MACHINE_NOTE}
            </span>
          )}
          <MachineSummary view={view} />
        </>
      }
      trailing={<MachineStatus view={view} />}
      onClick={onOpen}
    />
  )
})
