import type { JSX, ReactNode } from 'react'
import { lazy, Suspense } from 'react'
import { AutomationsView } from './AutomationsView'
import { HomeView } from './HomeView'
import { IssuesView } from './IssuesView'
import { SettingsView } from './SettingsView'
import { useStoreSelector } from './store'
import { UsageView } from './UsageView'

// Lazy: BlockNote (the spec WYSIWYG editor) is a heavy chunk only Specs needs —
// keeping it out of the shell bundle also keeps every precached file under
// workbox's 2 MB per-file cap.
const SpecsView = lazy(() => import('./SpecsView').then((m) => ({ default: m.SpecsView })))

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
