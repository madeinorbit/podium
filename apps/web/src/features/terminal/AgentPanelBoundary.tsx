import type { JSX } from 'react'
import { lazy, Suspense } from 'react'
import { WorkingMark } from '@/lib/motion/WorkingMark'
import type { AgentPanelProps } from './agent-panel-props'

const LazyAgentPanel = lazy(() =>
  import('./AgentPanel').then((module) => ({ default: module.AgentPanel })),
)

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
