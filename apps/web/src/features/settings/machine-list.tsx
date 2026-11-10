import { relativeTime } from '@podium/client-core/focus'
import { hostMemoryView } from '@podium/client-core/values'
import { observer } from '@podium/client-graph/react'
import { ChevronRight, Server } from 'lucide-react'
import { usePoolHostAggregate } from '@/app/header-data'
import { Badge } from '@/components/ui/badge'
import { useClock } from '@/lib/clock-hooks'
import { formatDisplayedVersion } from '@/lib/machine-version-skew'
import { useMemberRoster } from '@/lib/member-roster'
import { cn } from '@/lib/utils'
import type { SettingsMachine } from './machine-view'

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

export const MachineStatus = observer(function MachineStatus({ view }: { view: SettingsMachine }) {
  const machine = view.machine
  const lastSeen = !machine.online && !machine.revokedAt ? machine.lastSeenAt : undefined
  const now = useClock(30_000, lastSeen !== undefined)
  return (
    <Badge
      variant={view.status.tone === 'degraded' ? 'warning' : 'outline'}
      className="max-w-full gap-1.5 whitespace-normal font-normal"
      title={view.status.detail}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          view.status.tone === 'online'
            ? 'bg-success'
            : view.status.tone === 'degraded'
              ? 'bg-warning'
              : 'bg-muted-foreground/50',
        )}
      />
      {view.status.label}
      {lastSeen ? ` · Last seen ${relativeTime(lastSeen, now)}` : ''}
    </Badge>
  )
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
    <button
      type="button"
      data-pressable
      onClick={onOpen}
      aria-label={`Open ${machine.name}`}
      className="flex w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <Server size={18} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="settings-label break-words">{machine.name}</span>
          {role && (
            <Badge variant="outline" className="font-normal">
              {role}
            </Badge>
          )}
          {machine.unowned === true && <Badge variant="warning">Nobody looks after it</Badge>}
        </span>
        <span className="settings-prose mt-1 block">
          {machine.unowned === true ? (
            'Agents cannot run here until an admin adopts it'
          ) : (
            <>
              Looked after by <MachineCustodianName view={view} />
            </>
          )}
        </span>
        <MachineSummary view={view} />
      </span>
      <span className="flex max-w-[45%] shrink-0 items-center gap-2">
        <MachineStatus view={view} />
        <ChevronRight size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      </span>
    </button>
  )
})
