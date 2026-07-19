import type { JSX, ReactNode } from 'react'
import { lazy, Suspense } from 'react'
import { AutomationsView } from '@/features/automations/AutomationsView'
import { IssuesView } from '@/features/issues/IssuesView'
import { SettingsView } from '@/features/settings/SettingsView'
import { UsageView } from '@/features/usage/UsageView'
import { WorkflowsView } from '@/features/workflows/WorkflowsView'
import { useFeature } from '@/lib/use-feature'
import { useStoreSelector } from './store'

// Lazy: BlockNote (the spec WYSIWYG editor) is a heavy chunk only Specs needs —
// keeping it out of the shell bundle also keeps every precached file under
// workbox's 2 MB per-file cap.
const SpecsView = lazy(() =>
  import('@/features/specs/SpecsView').then((m) => ({ default: m.SpecsView })),
)

/**
 * The ONE route table (issue #15 Phase 4): the URL router resolves the current
 * `view`, and this outlet renders it. AppShell (desktop) and MobileApp share it
 * verbatim — the only per-shell difference is what "workspace" looks like.
 */
export function MainViewOutlet({
  workspace,
  issues,
}: {
  workspace: ReactNode
  /** Responsive shells can replace the desktop task board with their primary
   * work-navigation surface. [spec:SP-7696] */
  issues?: ReactNode
}): JSX.Element {
  const view = useStoreSelector((s) => s.view)
  const workflowsEnabled = useFeature('workflows')
  const specsEnabled = useFeature('specs')
  const automationsEnabled = useFeature('automations')
  const issuesView = <>{issues ?? <IssuesView />}</>
  switch (view) {
    case 'settings':
      return <SettingsView />
    case 'usage':
      return <UsageView />
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
