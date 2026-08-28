import type { JSX } from 'react'
import { useSyncExternalStore } from 'react'
import { isWaitingForServer, subscribeWaitingForServer } from '@/lib/chunk-recovery'

/**
 * THE FALLBACK THAT SAYS WHY IT IS STILL A FALLBACK (POD-2762).
 *
 * Every lazy surface in the shell suspends behind an empty box. That is right
 * for the ordinary case — a chunk arrives in tens of milliseconds and a spinner
 * would be a flash of anxiety about nothing. It is wrong for the case this issue
 * is about: the server is restarting, the chunk cannot arrive for another twenty
 * seconds, and an empty box reads as "your click did nothing".
 *
 * So the box learns one sentence, and only when it is true. `chunk-recovery`
 * publishes whether anything is currently waiting for the server to come back;
 * until that is the case this renders exactly what it rendered before, down to
 * the `aria-hidden`. There is no timer and no threshold to tune — the notice
 * appears because a fetch was actually refused, not because something is taking
 * a while.
 *
 * WHY IT IS NOT A SPINNER. A spinner says "working"; this has to say "waiting,
 * and here is what for", because the two have very different implications for
 * whether the person should keep sitting there. It also carries the one fact
 * that stops the moment being alarming: nothing has been lost.
 */
export function WaitingForServer({ className }: { className?: string }): JSX.Element {
  const waiting = useSyncExternalStore(subscribeWaitingForServer, isWaitingForServer, () => false)
  if (!waiting) return <div className={className} aria-hidden="true" />
  return (
    <div className={`${className ?? ''} items-center justify-center`}>
      <div
        className="flex flex-col items-center gap-2 px-6 py-10 text-center"
        // `status` rather than `alert`: a screen reader should hear this when it
        // gets to it, not be interrupted by it. Nothing has gone wrong.
        role="status"
      >
        <span className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground uppercase tracking-wider">
          <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />
          Reconnecting
        </span>
        <p className="max-w-[38ch] text-muted-foreground/80 text-sm leading-relaxed">
          Podium’s server is restarting, so this could not be fetched yet. It will open on its own
          as soon as the server is back — nothing has been lost.
        </p>
      </div>
    </div>
  )
}
