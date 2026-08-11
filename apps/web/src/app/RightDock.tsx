import { shallowEqual } from '@podium/client-core/store'
import {
  cwdInWorktree,
  issueForCwd,
  reposToViews,
  resolveActiveWorktree,
} from '@podium/client-core/viewmodels'
import {
  CircleDot,
  FolderTree,
  GitBranch,
  ListOrdered,
  type LucideIcon,
  Mail,
  Sparkles,
  SquareTerminal,
  X,
} from 'lucide-react'
import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { WorktreeFileTree } from '@/features/files/WorktreeFileTree'
import { GitPanelView } from '@/features/git/GitPanelView'
import { IssueExplorer, IssueExplorerCrumbs } from '@/features/issues/explorer/IssueExplorer'
import { MergeQueuePanel } from '@/features/merge-queue/MergeQueuePanel'
import { MessageLedgerView } from '@/features/messages/MessageLedgerView'
import { SuperagentView } from '@/features/superagent/SuperagentView'
import { DockShellPanel } from '@/features/terminal/DockShellPanel'
import { DockHeaderSlotProvider } from './DockHeaderSlot'
import { useOperatorFocus } from './operator-focus'
import type { RightPanelTab } from './shell-state'
import { useReplicaIssues, useStoreSelector } from './store'

/** The right-panel surfaces, including the docked Superagent chat home. */
export type { RightPanelTab } from './shell-state'

export const RIGHT_PANELS: { id: RightPanelTab; label: string; icon: LucideIcon }[] = [
  { id: 'issue', label: 'Task', icon: CircleDot },
  { id: 'superagent', label: 'Superagent', icon: Sparkles },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'files', label: 'Files', icon: FolderTree },
  // The dock hosts one persistent shell per worktree (#23) [spec:SP-75b1];
  // additional shells can also be opened as workspace tabs from the "+" menu.
  { id: 'shell', label: 'Shell', icon: SquareTerminal },
  // The message ledger (#237) [spec:SP-34d7 web] — the active session's and
  // its issue's delivery ledger ("what happened to my message").
  { id: 'mail', label: 'Messages', icon: Mail },
  { id: 'merge-queue', label: 'Queues', icon: ListOrdered },
]

/** The right dock panel: Files / Git / Issue / Superagent for the active worktree. Opened
 *  from the thin icon rail on the shell's right edge; one panel at a time. */
export function RightDock({
  tab,
  onClose,
}: {
  tab: RightPanelTab
  onClose: () => void
}): JSX.Element {
  const { paneA, fileTabs, sessions, repos, setSelectedIssueId } = useStoreSelector(
    (s) => ({
      paneA: s.paneA,
      fileTabs: s.fileTabs,
      sessions: s.sessions,
      repos: s.repos,
      setSelectedIssueId: s.setSelectedIssueId,
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const { setFocusedIssueId } = useOperatorFocus()
  const active = useMemo(
    () => resolveActiveWorktree({ paneA, fileTabs, sessions }),
    [paneA, fileTabs, sessions],
  )
  const panel = RIGHT_PANELS.find((p) => p.id === tab) ?? {
    id: tab,
    label: 'Panel',
    icon: FolderTree,
  }
  // The dock title bar is every panel's ONE header (POD-516 item 10): a panel
  // with controls of its own portals them in here instead of growing a second
  // bar with a second name under this one.
  const [headerActions, setHeaderActions] = useState<HTMLElement | null>(null)
  const mergeQueueScope = useMemo(() => {
    if (!active) return null

    for (const repo of reposToViews(repos)) {
      const worktree = repo.worktrees
        .filter(
          (candidate) =>
            (!active.machineId ||
              !candidate.machineId ||
              candidate.machineId === active.machineId) &&
            cwdInWorktree(active.cwd, candidate.path),
        )
        .sort((a, b) => b.path.length - a.path.length)[0]
      if (worktree) {
        return {
          repoId: repo.repoId ?? worktree.repoId ?? null,
          repoPath: worktree.repoPath,
        }
      }
    }

    // Repository discovery may lag behind the issue replica during startup.
    // An explicitly attached issue still carries the canonical repository root.
    const activeIssueId =
      active.issueId ?? sessions.find((session) => session.sessionId === active.sessionId)?.issueId
    const activeIssue = activeIssueId
      ? issues.find((issue) => issue.id === activeIssueId)
      : issueForCwd(issues, active.cwd)
    return activeIssue
      ? { repoId: activeIssue.repoId ?? null, repoPath: activeIssue.repoPath }
      : null
  }, [active, issues, repos, sessions])

  return (
    <DockHeaderSlotProvider value={headerActions}>
      <div className="flex min-h-0 flex-1 flex-col" data-right-dock-panel={tab}>
        {/* 44px, 14px of side padding, 9px between the mark, the name and the
            close — the Paper shell's head metrics (POD-725 §7). */}
        <div className="flex h-11 flex-none items-center gap-[9px] border-b border-border px-3.5">
          {tab === 'issue' ? (
            // The one panel whose header is not a name. The explorer moves
            // between tasks, so what belongs up here is where you are and how
            // to get back — the task's own name is the head of the panel below.
            <IssueExplorerCrumbs />
          ) : (
            <span className="flex min-w-0 flex-1 items-center gap-[9px]">
              {/* Chrome ink, not signal ink: this glyph is lit on every panel, and a
                permanently-yellow mark where nothing is asked of the operator is
                the exact spend The Signal Rule guards. */}
              <panel.icon size={16} className="flex-none text-text-dim" aria-hidden="true" />
              <span
                className="truncate text-[13.5px] leading-none font-semibold text-text-strong"
                data-dock-title="panel"
              >
                {panel.label}
              </span>
            </span>
          )}
          <span className="flex flex-none items-center gap-1">
            <span ref={setHeaderActions} className="flex items-center gap-1 empty:hidden" />
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 flex-none text-text-dim"
              title={`Close ${panel.label.toLowerCase()} panel`}
              onClick={onClose}
            >
              <X size={16} aria-hidden="true" />
            </Button>
          </span>
        </div>
        {tab === 'files' &&
          (active ? (
            <WorktreeFileTree key={active.cwd} root={active.cwd} machineId={active.machineId} />
          ) : (
            <div className="p-3 text-xs text-muted-foreground/70">No active session.</div>
          ))}
        {tab === 'git' &&
          (active ? (
            // Keyed by cwd: switching worktrees re-roots status/log/diff state.
            <GitPanelView
              key={active.cwd}
              cwd={active.cwd}
              machineId={active.machineId}
              issue={
                (active.issueId ? issues.find((i) => i.id === active.issueId) : undefined) ??
                issueForCwd(issues, active.cwd) ??
                undefined
              }
            />
          ) : (
            <div className="p-3 text-xs text-muted-foreground/70">No active session.</div>
          ))}
        {tab === 'mail' &&
          (active ? (
            <MessageLedgerView
              key={active.sessionId ?? active.cwd}
              sessionId={active.sessionId}
              issueId={
                sessions.find((s) => s.sessionId === active.sessionId)?.issueId ??
                issueForCwd(issues, active.cwd)?.id
              }
            />
          ) : (
            <div className="p-3 text-xs text-muted-foreground/70">No active session.</div>
          ))}
        {tab === 'issue' &&
          (active ? (
            // Not keyed on the worktree: the explorer's whole point is that it
            // outlives what the workspace is pointed at. `cwd` only tells it
            // where to serve the artifacts of a task with no checkout of its own.
            <IssueExplorer cwd={active.cwd} machineId={active.machineId} />
          ) : (
            <IssueExplorer cwd="" />
          ))}
        {tab === 'superagent' && <SuperagentView />}
        {tab === 'shell' &&
          (active ? (
            // Keyed by cwd: switching worktrees swaps to THAT worktree's shell.
            <DockShellPanel key={active.cwd} cwd={active.cwd} machineId={active.machineId} />
          ) : (
            <div className="p-3 text-xs text-muted-foreground/70">No active worktree.</div>
          ))}
        {tab === 'merge-queue' && (
          <MergeQueuePanel
            issues={issues}
            scope={mergeQueueScope}
            // A queue entry can be any issue in the repo, including one outside
            // the mission on screen — so this moves the MISSION, not just the
            // focus inside it. Focusing alone would be discarded by
            // `resolveFocus` as not-in-mission and silently snap back.
            onSelectIssue={(issue) => {
              setSelectedIssueId(issue.id)
              setFocusedIssueId(issue.id)
            }}
          />
        )}
      </div>
    </DockHeaderSlotProvider>
  )
}
