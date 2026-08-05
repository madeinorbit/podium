import type { JSX, ReactNode } from 'react'
import { lazy, Suspense } from 'react'
import { AutomationsView } from '@/features/automations/AutomationsView'
import { IssuesView } from '@/features/issues/IssuesView'
import { WorkflowsView } from '@/features/workflows/WorkflowsView'
import { useFeature } from '@/lib/use-feature'
import { type MainView, useStoreSelector } from './store'

// Lazy: BlockNote (the spec WYSIWYG editor) is a heavy chunk only Specs needs —
// keeping it out of the shell bundle also keeps every precached file under
// workbox's 2 MB per-file cap.
const SpecsView = lazy(() =>
  import('@/features/specs/SpecsView').then((m) => ({ default: m.SpecsView })),
)

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
  const storeView = useStoreSelector((s) => s.view)
  const view = viewOverride ?? storeView
  const workflowsEnabled = useFeature('workflows')
  const specsEnabled = useFeature('specs')
  const automationsEnabled = useFeature('automations')
  const issuesView = <>{issues ?? <IssuesView />}</>
  switch (view) {
    case 'settings':
    case 'usage':
      // Both are utility SHEETS rendered by AppShell over a live shell; the
      // outlet never sees them unless the base view was somehow one of them.
      return <>{workspace}</>
    case 'issues':
      return issuesView
    case 'workflows':
      return workflowsEnabled ? <WorkflowsView /> : issuesView
    case 'automations':
      return automationsEnabled ? <AutomationsView /> : issuesView
    case 'specs':
      if (!specsEnabled) return issuesView
      return (
        <Suspense fallback={<div className="flex flex-1 items-center justify-center" />}>
          <SpecsView />
        </Suspense>
      )
    case 'workspace':
      return <>{workspace}</>
  }
}
