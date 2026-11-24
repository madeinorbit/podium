import { observer } from '@podium/client-graph/react'
import { MachineLastSeen, MachinePresenceDot } from '@/components/machine-presence'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { SettingsMachine } from './machine-view'

export const MachineStatus = observer(function MachineStatus({ view }: { view: SettingsMachine }) {
  const machine = view.machine
  return (
    <Badge
      variant={view.status.tone === 'degraded' ? 'warning' : 'outline'}
      className="max-w-full gap-1.5 whitespace-normal font-normal"
      title={view.status.detail}
    >
      {view.status.tone === 'degraded' || view.status.tone === 'off' ? (
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            view.status.tone === 'degraded' ? 'bg-warning' : 'bg-muted-foreground/50',
          )}
        />
      ) : (
        <MachinePresenceDot machine={machine} />
      )}
      {view.status.label}
      <MachineLastSeen machine={machine} />
    </Badge>
  )
})
