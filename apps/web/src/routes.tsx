import type { JSX, ReactNode } from 'react'
import { HomeView } from './HomeView'
import { IssuesView } from './IssuesView'
import { AutomationsView } from './AutomationsView'
import { SettingsView } from './SettingsView'
import { useStoreSelector } from './store'
import { UsageView } from './UsageView'

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
    case 'workspace':
      return <>{workspace}</>
  }
}
