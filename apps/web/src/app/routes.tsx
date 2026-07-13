import type { JSX, ReactNode } from 'react'
import { lazy, Suspense } from 'react'
import { AutomationsView } from '@/features/automations/AutomationsView'
import { IssuesView } from '@/features/issues/IssuesView'
import { SettingsView } from '@/features/settings/SettingsView'
import { UsageView } from '@/features/usage/UsageView'
import { WorkflowsView } from '@/features/workflows/WorkflowsView'
import { HomeView } from '@/features/worklist/HomeView'
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
 * verbatim — the only per-shell differences are what "workspace" looks like and,
 * since #227, what "home" is: desktop's home is the Command center, mobile's is
 * the sidebar work list (which desktop shows in its always-present sidebar).
 */
export function MainViewOutlet({
  workspace,
  home,
}: {
  workspace: ReactNode
  home?: JSX.Element
}): JSX.Element {
  const view = useStoreSelector((s) => s.view)
  switch (view) {
    case 'home':
      return home ?? <HomeView />
    case 'settings':
      return <SettingsView />
    case 'usage':
      return <UsageView />
    case 'issues':
      return <IssuesView />
    case 'workflows':
      return <WorkflowsView />
    case 'automations':
      return <AutomationsView />
    case 'specs':
      return (
        <Suspense fallback={<div className="flex flex-1 items-center justify-center" />}>
          <SpecsView />
        </Suspense>
      )
    case 'workspace':
      return <>{workspace}</>
  }
}
