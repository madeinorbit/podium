import type { JSX } from 'react'
import { lazy, Suspense } from 'react'
import { throughRestarts } from '@/lib/chunk-recovery'
import { WorkingMark } from '@/lib/motion/WorkingMark'
import type { AgentPanelProps } from './agent-panel-props'

/**
 * ONE lazy binding for every call site, and it goes `throughRestarts`.
 *
 * The single module-scope `lazy()` is what keeps `AgentPanel` one component
 * identity across the deck, the orphan pane and the setup dialog: two `lazy()`
 * calls over the same specifier would share a chunk but not an identity, and a
 * tab that moved between call sites would remount its terminal.
 *
 * `throughRestarts` because this chunk is fetched long after the shell loaded,
 * and a deploy in between makes the old hashed URL a 404 — which arrives here
 * as a permanently broken panel rather than a retryable error.
 */
const LazyAgentPanel = lazy(() =>
  throughRestarts(() => import('./AgentPanel')).then((module) => ({ default: module.AgentPanel })),
)

/** Warm the panel chunk once the shell is up; see prefetchAfterFirstPaint. */
export function loadAgentPanel(): Promise<unknown> {
  return import('./AgentPanel')
}

/**
 * Keep the session, terminal, and transcript graph out of the cold web shell.
 * The boundary is mounted only where a session panel belongs, so an active
 * session starts loading immediately while session-free routes avoid the work.
 */
export function AgentPanelBoundary(props: AgentPanelProps): JSX.Element {
  return (
    <Suspense
      fallback={
        <div
          className="flex min-h-0 min-w-0 flex-1 items-center justify-center text-text-dim"
          role="status"
          aria-label="Loading session"
        >
          <WorkingMark size={18} />
        </div>
      }
    >
      <LazyAgentPanel {...props} />
    </Suspense>
  )
}
