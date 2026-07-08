import type { JSX, ReactNode } from 'react'
import { lazy, Suspense } from 'react'
import { HomeView } from './HomeView'
import { IssuesView } from './IssuesView'
import { AutomationsView } from './AutomationsView'
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
 * verbatim — the only per-shell difference is what "workspace" looks like, so
 * that surface comes in as a prop (mobile chrome is a rendering concern, not a
 * navigation concern).
 */
export function MainViewOutlet({ workspace }: { workspace: ReactNode }): JSX.Element {
  const view = useStoreSelector((s) => s.view)
  switch (view) {
    case 'home':
      return <HomeView />
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
