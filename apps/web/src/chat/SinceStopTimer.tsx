import { formatElapsed } from '@podium/client-core/viewmodels'
import { Clock } from 'lucide-react'
import type { JSX } from 'react'
import { useNow } from '../useNow'

/** Live "Idle for …" clock since the agent last changed phase (its last stop). */
export function SinceStopTimer({ since }: { since: string }): JSX.Element | null {
  const now = useNow(1000)
  const ms = Date.parse(since)
  if (Number.isNaN(ms)) return null
  return (
    <div className="mx-auto flex w-full max-w-[960px] items-center gap-1.5 py-2 pl-[calc(3px+12px)] text-[11px] text-muted-foreground/55">
      <Clock size={11} aria-hidden="true" />
      Idle for {formatElapsed(ms, now)}
    </div>
  )
}
