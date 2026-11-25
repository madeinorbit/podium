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
  unavailable = false,
  className,
}: {
  /** The field's answer; only `LOADING` reaches here. */
  value: typeof LOADING
  /** What is loading, for the screen reader: "description", "brief". */
  what: string
  /** The server refused it (POD-7595): it will not load by itself. */
  unavailable?: boolean
  className?: string
}): JSX.Element {
  const pool = useWorklistPool()
  const offline = pool?.collections.reading(value) === 'offline'
  if (unavailable) return <NotAvailable what={what} className={className} />
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

/**
 * POD-7595 — what a section or a list shows when the server refused what it
 * reads: it will not load by itself (the connection's return, an access
 * change or a retry asks again). Never "Loading…", an empty state or a count.
 */
export function NotAvailable({
  what,
  className,
}: {
  /** What is not available, for the screen reader: "sub-tasks", "sessions". */
  what: string
  className?: string
}): JSX.Element {
  return (
    <p
      role="status"
      aria-label={`${what[0]?.toUpperCase() ?? ''}${what.slice(1)}: not available`}
      data-body-pending="unavailable"
      className={cn('text-[12.5px] text-muted-foreground/60', className)}
    >
      Not available
    </p>
  )
}
