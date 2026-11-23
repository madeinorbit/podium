import { useUiValue } from '@podium/client-core/react'
import type { JSX, ReactNode } from 'react'
import { Suspense } from 'react'
import { lazyScreen } from '@/components/LazyScreen'
import { WaitingForServer } from '@/components/WaitingForServer'
import { useFeature } from '@/lib/use-feature'
import type { MainView } from './store'

const AutomationsView = lazyScreen(
  () => import('@/features/automations/AutomationsView'),
  (module) => module.AutomationsView,
)
const IssuesView = lazyScreen(
  () => import('@/features/issues/IssuesView'),
  (module) => module.IssuesView,
)
const WorkflowsView = lazyScreen(
  () => import('@/features/workflows/WorkflowsView'),
  (module) => module.WorkflowsView,
)
function ViewFallback(): JSX.Element {
  return <WaitingForServer className="flex min-h-0 min-w-0 flex-1" />
}

function lazyView(view: ReactNode): JSX.Element {
  return <Suspense fallback={<ViewFallback />}>{view}</Suspense>
}

/**
 * The ONE route table (issue #15 Phase 4): the URL router resolves the current
 * `view`, and this outlet renders it for the desktop shell. (Mobile is the
 * Expo app at /mobile — the responsive shell is gone, POD-102.)
 */
export function MainViewOutlet({
  workspace,
  issues,
  view: viewOverride,
}: {
  workspace: ReactNode
  issues?: ReactNode
  /** The MODE to render. Overlay views (Settings, Usage) pass the mode they are
   *  floating over, so the shell behind a sheet keeps showing real work
   *  (POD-365) instead of blinking out of existence. */
  view?: MainView
}): JSX.Element {
  const storeView = useUiValue('view')
  const view = viewOverride ?? storeView
  const workflowsEnabled = useFeature('workflows')
  const automationsEnabled = useFeature('automations')
  const issuesView = issues ?? lazyView(<IssuesView />)
  switch (view) {
    case 'settings':
    case 'usage':
      // Both are utility SHEETS rendered by AppShell over a live shell; the
      // outlet never sees them unless the base view was somehow one of them.
      return <>{workspace}</>
    case 'issues':
      return <>{issuesView}</>
    case 'workflows':
      return workflowsEnabled ? lazyView(<WorkflowsView />) : <>{issuesView}</>
    case 'automations':
      return automationsEnabled ? lazyView(<AutomationsView />) : <>{issuesView}</>
    case 'workspace':
      return <>{workspace}</>
  }
}
