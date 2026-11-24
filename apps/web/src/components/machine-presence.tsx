import { relativeTime } from '@podium/client-core/focus'
import { type MachinePresenceReading, machinePresence } from '@podium/model/browser'
import { observer } from 'mobx-react-lite'
import { useClock } from '@/lib/clock-hooks'
import { cn } from '@/lib/utils'

type PresenceMachine = MachinePresenceReading & {
  readonly lastSeenAt?: string
  readonly revokedAt?: string | null
}

export const MachinePresenceDot = observer(function MachinePresenceDot({
  machine,
  className,
}: {
  machine: MachinePresenceReading
  className?: string
}) {
  const presence = machinePresence(machine)
  return (
    <span
      aria-hidden="true"
      title={presence}
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        presence === 'Online'
          ? 'bg-success'
          : presence === 'Reconnecting'
            ? 'bg-muted-foreground/50'
            : 'bg-destructive',
        className,
      )}
    />
  )
})

export const MachineLastSeen = observer(function MachineLastSeen({
  machine,
}: {
  machine: PresenceMachine
}) {
  const lastSeen =
    machinePresence(machine) !== 'Online' && !machine.revokedAt ? machine.lastSeenAt : undefined
  const now = useClock(30_000, lastSeen !== undefined)
  return lastSeen ? <> · Last seen {relativeTime(lastSeen, now)}</> : null
})

export const MachinePresenceText = observer(function MachinePresenceText({
  machine,
}: {
  machine: PresenceMachine
}) {
  return (
    <>
      {machinePresence(machine)}
      <MachineLastSeen machine={machine} />
    </>
  )
})
