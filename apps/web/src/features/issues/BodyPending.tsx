import type { LOADING } from '@podium/client-graph/loading'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { cn } from '@/lib/utils'

/**
 * What a section shows while an issue body field answers `LOADING`: its read
 * holds the record and loads it, so the section waits quietly, never "Add a
 * description…" or an empty block (POD-7545, POD-7546).
 * Without a connection the load cannot start: the pool reads that LOADING as
 * `offline` (`pool.collections.reading`), and the section says so; it fills
 * by itself once the connection returns.
 */
export const BodyPending = observer(function BodyPending({
  value,
  what,
  className,
}: {
  /** The field's answer; only `LOADING` reaches here. */
  value: typeof LOADING
  /** What is loading, for the screen reader: "description", "brief". */
  what: string
  className?: string
}): JSX.Element {
  const pool = useWorklistPool()
  const offline = pool?.collections.reading(value) === 'offline'
  return (
    <p
      role="status"
      aria-busy={!offline}
      aria-label={offline ? `The ${what} is not available offline` : `Loading the ${what}`}
      data-body-pending={offline ? 'offline' : 'loading'}
      className={cn('text-[12.5px] text-muted-foreground/60', className)}
    >
      {offline ? 'Not available offline' : 'Loading…'}
    </p>
  )
})
