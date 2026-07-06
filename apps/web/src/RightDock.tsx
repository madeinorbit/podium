import { CircleDot, FolderTree, GitBranch, type LucideIcon, Sparkles } from 'lucide-react'
import type { JSX } from 'react'
import { useMemo } from 'react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { type DockTab, resolveActiveWorktree } from './dock-panel'
import { IssuePanelView } from './IssuePanelView'
import { useStore } from './store'
import { SuperagentView } from './SuperagentView'
import { WorktreeFileTree } from './WorktreeFileTree'

const TABS: { id: DockTab; label: string; icon: LucideIcon }[] = [
  { id: 'superagent', label: 'Superagent', icon: Sparkles },
  { id: 'files', label: 'Files', icon: FolderTree },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'issue', label: 'Issue', icon: CircleDot },
]

function GitPlaceholder(): JSX.Element {
  return (
    <div className="p-3 text-xs text-muted-foreground/70">
      <div className="font-medium text-muted-foreground">Git — coming soon</div>
      <ul className="mt-2 list-disc pl-4">
        <li>Working-tree status</li>
        <li>Diff view</li>
        <li>Commit log</li>
      </ul>
    </div>
  )
}

/** IDE-style right dock: Superagent | Files | Git | Issue tabs. `superOpen`
 *  stays the open/close flag; the active tab persists as `dockTab`. */
export function RightDock(): JSX.Element {
  const { dockTab, setDockTab, setSuperOpen, paneA, fileTabs, sessions } = useStore()
  const active = useMemo(
    () => resolveActiveWorktree({ paneA, fileTabs, sessions }),
    [paneA, fileTabs, sessions],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Tabs
        value={dockTab}
        onValueChange={(v) => setDockTab(v as DockTab)}
        className="flex-none gap-0 border-b border-border px-2 pt-1"
      >
        <TabsList variant="line" className="w-full justify-start">
          {TABS.map((t) => (
            <TabsTrigger
              key={t.id}
              value={t.id}
              className="gap-1.5 text-xs"
              aria-label={t.label}
              title={t.label}
            >
              <t.icon size={14} aria-hidden="true" />
              <span>{t.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {dockTab === 'superagent' && <SuperagentView onClose={() => setSuperOpen(false)} />}
      {dockTab === 'files' &&
        (active ? (
          <WorktreeFileTree key={active.cwd} root={active.cwd} machineId={active.machineId} />
        ) : (
          <div className="p-3 text-xs text-muted-foreground/70">No active session.</div>
        ))}
      {dockTab === 'git' && <GitPlaceholder />}
      {dockTab === 'issue' &&
        (active ? (
          <IssuePanelView cwd={active.cwd} machineId={active.machineId} />
        ) : (
          <div className="p-3 text-xs text-muted-foreground/70">No active session.</div>
        ))}
    </div>
  )
}
