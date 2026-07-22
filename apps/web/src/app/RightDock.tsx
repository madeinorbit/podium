import { shallowEqual } from '@podium/client-core/store'
import {
  CircleDot,
  FolderTree,
  GitBranch,
  type LucideIcon,
  Mail,
  SquareTerminal,
  X,
} from 'lucide-react'
import type { JSX } from 'react'
import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { WorktreeFileTree } from '@/features/files/WorktreeFileTree'
import { GitPanelView } from '@/features/git/GitPanelView'
import { IssuePanelView } from '@/features/issues/IssuePanelView'
import { MessageLedgerView } from '@/features/messages/MessageLedgerView'
import { DockShellPanel } from '@/features/terminal/DockShellPanel'
import { issueForCwd, resolveActiveWorktree } from '@/lib/dock-panel'
import type { RightPanelTab } from './shell-state'
import { useStoreSelector } from './store'

/** The right-panel surfaces (the superagent lives in its own center column). */
export type { RightPanelTab } from './shell-state'

export const RIGHT_PANELS: { id: RightPanelTab; label: string; icon: LucideIcon }[] = [
  { id: 'issue', label: 'Task', icon: CircleDot },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'files', label: 'Files', icon: FolderTree },
  // The dock hosts one persistent shell per worktree (#23) [spec:SP-75b1];
  // additional shells can also be opened as workspace tabs from the "+" menu.
  { id: 'shell', label: 'Shell', icon: SquareTerminal },
  // The message ledger (#237) [spec:SP-34d7 web] — the active session's and
  // its issue's delivery ledger ("what happened to my message").
  { id: 'mail', label: 'Messages', icon: Mail },
]

/** The right dock panel: Files / Git / Issue for the active worktree. Opened
 *  from the thin icon rail on the shell's right edge; one panel at a time. */
export function RightDock({
  tab,
  onClose,
}: {
  tab: RightPanelTab
  onClose: () => void
}): JSX.Element {
  const { paneA, fileTabs, sessions, issues, selectedIssueId } = useStoreSelector(
    (s) => ({
      paneA: s.paneA,
      fileTabs: s.fileTabs,
      sessions: s.sessions,
      issues: s.issues,
      selectedIssueId: s.selectedIssueId,
    }),
    shallowEqual,
  )
  const active = useMemo(
    () => resolveActiveWorktree({ paneA, fileTabs, sessions }),
    [paneA, fileTabs, sessions],
  )
  const panel = RIGHT_PANELS.find((p) => p.id === tab) ?? {
    id: tab,
    label: 'Panel',
    icon: FolderTree,
  }
  // Task navigation is issue-first: selecting a sidebar row must update this
  // dock even when the issue has no live session to become the active pane.
  // The other dock tabs remain pane/worktree-driven.
  const selectedIssue = selectedIssueId
    ? issues.find((issue) => issue.id === selectedIssueId && !issue.archived && !issue.deletedAt)
    : undefined

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-right-dock-panel={tab}>
      <div className="flex h-11 flex-none items-center gap-2.5 border-b border-border px-3.5">
        <span className="flex min-w-0 flex-1 items-center gap-[7px]">
          <panel.icon size={16} className="flex-none text-primary" aria-hidden="true" />
          <span className="truncate text-[15px] font-semibold text-secondary-foreground">
            {panel.label}
          </span>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7 flex-none text-muted-foreground"
          title={`Close ${panel.label.toLowerCase()} panel`}
          onClick={onClose}
        >
          <X size={14} aria-hidden="true" />
        </Button>
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
        (selectedIssue ? (
          <IssuePanelView
            cwd={selectedIssue.worktreePath ?? selectedIssue.repoPath}
            machineId={selectedIssue.machineId}
            issueId={selectedIssue.id}
          />
        ) : active ? (
          <IssuePanelView
            cwd={active.cwd}
            machineId={active.machineId}
            sessionId={active.sessionId}
            issueId={active.issueId}
          />
        ) : (
          <div className="p-3 text-xs text-muted-foreground/70">No active session.</div>
        ))}
      {tab === 'shell' &&
        (active ? (
          // Keyed by cwd: switching worktrees swaps to THAT worktree's shell.
          <DockShellPanel key={active.cwd} cwd={active.cwd} machineId={active.machineId} />
        ) : (
          <div className="p-3 text-xs text-muted-foreground/70">No active worktree.</div>
        ))}
    </div>
  )
}
