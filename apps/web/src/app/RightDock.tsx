import { shallowEqual } from '@podium/client-core/store'
import { issueDisplayRef } from '@podium/protocol'
import {
  CircleDot,
  ExternalLink,
  FolderTree,
  GitBranch,
  type LucideIcon,
  Mail,
  SquareTerminal,
  X,
} from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { WorktreeFileTree } from '@/features/files/WorktreeFileTree'
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

/** The right dock panel: Files / Git / Issue for the active worktree — or a
 *  transient issue PEEK (POD-95): a chat ref opened in place, as a labeled tab
 *  beside the selected panel so it can't be mistaken for the current task. */
export function RightDock({
  tab,
  peekIssueId,
  onClose,
  onClosePeek,
}: {
  /** Null when only a peek holds the dock open. */
  tab: RightPanelTab | null
  peekIssueId?: string | null
  onClose: () => void
  onClosePeek?: () => void
}): JSX.Element | null {
  const { paneA, fileTabs, sessions, issues, setOpenIssueId, setView } = useStoreSelector(
    (s) => ({
      paneA: s.paneA,
      fileTabs: s.fileTabs,
      sessions: s.sessions,
      issues: s.issues,
      setOpenIssueId: s.setOpenIssueId,
      setView: s.setView,
    }),
    shallowEqual,
  )
  const active = useMemo(
    () => resolveActiveWorktree({ paneA, fileTabs, sessions }),
    [paneA, fileTabs, sessions],
  )
  const panel = tab
    ? (RIGHT_PANELS.find((p) => p.id === tab) ?? { id: tab, label: 'Panel', icon: FolderTree })
    : null
  const peekIssue = peekIssueId
    ? (issues.find((i) => i.id === peekIssueId && !i.deletedAt) ?? null)
    : null
  // IssuePanelView's explicit-id path skips archived issues — render the tab
  // (identity) from the laxer lookup but say "archived" instead of mounting a
  // panel that would contradict it with "no issue attached".
  const peekRenderable = peekIssue != null && !peekIssue.archived
  const peeking = peekIssueId != null

  // Escape closes the peek — one rung down the ladder (page → peek → miniview),
  // with the same pass-throughs as the miniview card: a terminal or an open
  // dialog owns its own Escape.
  useEffect(() => {
    if (!peeking || !onClosePeek) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const t = e.target instanceof Element ? e.target : null
      if (t?.closest('.xterm')) return
      if (t?.closest('[role=dialog],[role=alertdialog]')) return
      onClosePeek()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [peeking, onClosePeek])

  if (peeking) {
    const peekRef = peekIssue ? issueDisplayRef(peekIssue) : null
    return (
      // Keyed by the peeked issue: the arrival motion (slide from the right
      // edge + the tab's amber flash) replays when one peek replaces another —
      // without it the swap is a blink you miss unless you're staring at it.
      <div
        key={peekIssueId}
        className="flex min-h-0 flex-1 animate-in flex-col fade-in slide-in-from-right-8 duration-300"
        data-right-dock-panel="peek"
      >
        <div className="flex h-11 flex-none items-center gap-1.5 border-b border-border px-2.5">
          {panel && (
            // The panel underneath stays one click away — that visible escape
            // hatch is what keeps the peek from reading as the current task.
            <button
              type="button"
              className="flex flex-none items-center gap-1.5 rounded px-2 py-1 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
              title={`Back to ${panel.label.toLowerCase()}`}
              onClick={onClosePeek}
            >
              <panel.icon size={14} aria-hidden="true" />
              {panel.label}
            </button>
          )}
          <span
            // morph-row-flash (motion.css): one amber flash decaying to the
            // resting bg-primary/10 — the "look here" moment of the arrival.
            className="morph-row-flash flex min-w-0 flex-1 items-center gap-[7px] rounded bg-primary/10 px-2 py-1"
            data-testid="dock-peek-tab"
          >
            <span className="flex-none font-mono text-[12px] font-medium text-primary">
              {peekRef ?? '#?'}
            </span>
            <span className="truncate text-[13px] italic text-secondary-foreground">
              {peekIssue?.title ?? 'Issue not found'}
            </span>
          </span>
          {peekIssue && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 flex-none text-muted-foreground"
              title="Open full page"
              onClick={() => {
                onClosePeek?.()
                setOpenIssueId(peekIssue.id)
                setView('issues')
              }}
            >
              <ExternalLink size={13} aria-hidden="true" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 flex-none text-muted-foreground"
            title="Close peek"
            onClick={onClosePeek}
          >
            <X size={14} aria-hidden="true" />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {peekRenderable ? (
            <IssuePanelView
              cwd={active?.cwd ?? ''}
              machineId={active?.machineId}
              issueId={peekIssue.id}
            />
          ) : (
            <div className="p-3 text-xs text-muted-foreground/70">
              {peekIssue ? 'This issue is archived.' : 'This issue is no longer available.'}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (!panel || !tab) return null
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
      {tab === 'git' && <GitPlaceholder />}
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
