import { shallowEqual } from '@podium/client-core/store'
import {
  cwdInWorktree,
  issueForCwd,
  issueForPanel,
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
import { IssuePanelView } from '@/features/issues/IssuePanelView'
import { StageGlyph } from '@/features/issues/issue-glyphs'
import { MergeQueuePanel } from '@/features/merge-queue/MergeQueuePanel'
import { MessageLedgerView } from '@/features/messages/MessageLedgerView'
import { SuperagentView } from '@/features/superagent/SuperagentView'
import { DockShellPanel } from '@/features/terminal/DockShellPanel'
import { missionIssueIds, missionRootFor } from '@/lib/mission'
import { DockHeaderSlotProvider } from './DockHeaderSlot'
import { resolveFocus, useOperatorFocus } from './operator-focus'
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
  { id: 'merge-queue', label: 'Merge queue', icon: ListOrdered },
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
  const { paneA, fileTabs, sessions, repos, selectedIssueId, setSelectedIssueId } =
    useStoreSelector(
      (s) => ({
        paneA: s.paneA,
        fileTabs: s.fileTabs,
        sessions: s.sessions,
        repos: s.repos,
        selectedIssueId: s.selectedIssueId,
        setSelectedIssueId: s.setSelectedIssueId,
      }),
      shallowEqual,
    )
  const issues = useReplicaIssues()
  const { focusedIssueId, setFocusedIssueId } = useOperatorFocus()
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
  // Task navigation is issue-first: selecting a sidebar row must update this
  // dock even when the issue has no live session to become the active pane.
  // The other dock tabs remain pane/worktree-driven.
  //
  // The inspected task is the operator's FOCUS inside the selected mission —
  // resolved against that mission so a pointer left over from the mission you
  // navigated away from falls back to the new root instead of inspecting a task
  // that is no longer on screen.
  //
  // Resolved against the mission ROOT's membership, which is the set the Flight
  // Deck renders. Resolving against `selectedIssueId` alone made the two
  // columns disagree whenever the selection was a child: the deck's set was the
  // whole mission, this one only that child's subtree, so a focus on a sibling
  // fell back here and inspected the wrong task.
  const inspectedId = useMemo(() => {
    const root = missionRootFor(issues, selectedIssueId)
    return resolveFocus(
      focusedIssueId,
      root ? missionIssueIds(issues, root.id, sessions) : new Set<string>(),
      root?.id ?? selectedIssueId,
    )
  }, [focusedIssueId, issues, selectedIssueId, sessions])
  const selectedIssue = inspectedId
    ? issues.find((issue) => issue.id === inspectedId && !issue.archived && !issue.deletedAt)
    : undefined
  // What the title bar SAYS on the Task tab (POD-516 r3 #7). Every other panel
  // is one thing and wears its own name; the Task panel is a different task
  // every time you touch the sidebar, so "Task" was a label that never told the
  // operator which one — while the panel below it spent a whole line of its
  // fixed head repeating a title the header should have carried.
  //
  // Resolved with `issueForPanel`, the SAME pure function the panel resolves
  // with and from the same inputs, so the bar and the body can never name two
  // different tasks. When it comes back null the panel is showing its intake
  // state and the bar falls back to the generic label.
  const dockIssue = useMemo(() => {
    if (tab !== 'issue') return null
    if (selectedIssue) return selectedIssue
    if (!active) return null
    return issueForPanel({
      issues,
      sessions,
      cwd: active.cwd,
      sessionId: active.sessionId,
      issueId: active.issueId,
    })
  }, [tab, selectedIssue, active, issues, sessions])
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
        <div className="flex h-11 flex-none items-center gap-2.5 border-b border-border px-3.5">
          {/* Keyed on what is named, so switching the inspected task is a one-shot
              200ms morph rather than a snap — the identity is the one thing in
              this bar that changes while you watch it. No perpetual motion. */}
          <span
            key={dockIssue?.id ?? panel.id}
            className="flex min-w-0 flex-1 animate-in items-center gap-[7px] fade-in slide-in-from-left-1 duration-200 motion-reduce:animate-none"
          >
            {dockIssue ? (
              // The stage, once, where the panel used to draw it a second time.
              <StageGlyph stage={dockIssue.stage} size={15} />
            ) : (
              /* Chrome ink, not signal ink: this glyph is lit on every panel, and a
                permanently-yellow mark where nothing is asked of the operator is
                the exact spend The Signal Rule guards. */
              <panel.icon size={16} className="flex-none text-text-dim" aria-hidden="true" />
            )}
            <span
              className="truncate text-[15px] font-semibold text-secondary-foreground"
              // A dock this narrow truncates most real titles, so the full one
              // has to be one hover away.
              title={dockIssue?.title}
              data-dock-title={dockIssue ? 'issue' : 'panel'}
            >
              {dockIssue ? dockIssue.title : panel.label}
            </span>
          </span>
          <span className="flex flex-none items-center gap-1">
            <span ref={setHeaderActions} className="flex items-center gap-1 empty:hidden" />
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 flex-none text-muted-foreground"
              title={`Close ${panel.label.toLowerCase()} panel`}
              onClick={onClose}
            >
              <X size={14} aria-hidden="true" />
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
