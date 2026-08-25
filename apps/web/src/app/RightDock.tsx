import { shallowEqual } from '@podium/client-core/store'
import {
  cwdInWorktree,
  issueForCwd,
  reposToViews,
  resolveActiveWorktree,
} from '@podium/client-core/viewmodels'
import {
  FolderTree,
  GitBranch,
  ListOrdered,
  ListTree,
  type LucideIcon,
  Mail,
  Sparkles,
  SquareTerminal,
  X,
} from 'lucide-react'
import type { JSX } from 'react'
import { lazy, Suspense, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { WaitingForServer } from '@/components/WaitingForServer'
import { PerspectiveRoad } from '@/features/shipping/PerspectiveRoad'
import type { ShippingPanelCommands } from '@/features/shipping/ShippingPanel'
import { throughRestarts } from '@/lib/chunk-recovery'
import { DockHeaderSlotProvider } from './DockHeaderSlot'
import { useOperatorFocus } from './operator-focus'
import type { RightPanelTab } from './shell-state'
import { useReplicaIssues, useStoreSelector } from './store'

const WorktreeFileTree = lazy(() =>
  throughRestarts(() => import('@/features/files/WorktreeFileTree')).then((module) => ({
    default: module.WorktreeFileTree,
  })),
)
const GitPanelView = lazy(() =>
  throughRestarts(() => import('@/features/git/GitPanelView')).then((module) => ({
    default: module.GitPanelView,
  })),
)
const RightDockIssuePanel = lazy(() => throughRestarts(() => import('./RightDockIssuePanel')))
/**
 * The seventh dock panel, deferred like the other six (POD-2730). It used to be
 * the one static import in this list, with the note "changing xterm's
 * mount/attach timing belongs to POD-847" — but a lazy MODULE is not a changed
 * mount: the component still mounts synchronously once its chunk is resolved,
 * under the same `<Suspense fallback={<DockPanelFallback />}>` as its siblings,
 * and it only renders at all when `tab === 'shell'`, which is a click.
 *
 * What it did change was the first paint of every session that never opens this
 * tab, because this is one of the two doors xterm came through.
 */
const DockShellPanel = lazy(() =>
  throughRestarts(() => import('@/features/terminal/DockShellPanel')).then((module) => ({
    default: module.DockShellPanel,
  })),
)
const MergeQueuePanel = lazy(() =>
  throughRestarts(() => import('@/features/merge-queue/MergeQueuePanel')).then((module) => ({
    default: module.MergeQueuePanel,
  })),
)
const ShippingPanel = lazy(() =>
  throughRestarts(() => import('@/features/shipping/ShippingPanel')).then((module) => ({
    default: module.ShippingPanel,
  })),
)
const MessageLedgerView = lazy(() =>
  throughRestarts(() => import('@/features/messages/MessageLedgerView')).then((module) => ({
    default: module.MessageLedgerView,
  })),
)
const SuperagentView = lazy(() =>
  throughRestarts(() => import('@/features/superagent/SuperagentView')).then((module) => ({
    default: module.SuperagentView,
  })),
)

function DockPanelFallback(): JSX.Element {
  return <WaitingForServer className="flex min-h-0 flex-1" />
}

/** The right-panel surfaces, including the docked Superagent chat home. */
export type { RightPanelTab } from './shell-state'

export const RIGHT_PANELS: { id: RightPanelTab; label: string; icon: LucideIcon }[] = [
  // A LIST glyph, not a task glyph (POD-743): this cell opens an explorer
  // over every task in the repo, so an icon that stands for one issue — and,
  // before this, the selected issue's own ID square wearing its status badge —
  // named the wrong thing and claimed a relationship the panel no longer has.
  { id: 'issue', label: 'Tasks', icon: ListTree },
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
  { id: 'shipping', label: 'Shipping', icon: PerspectiveRoad },
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
  const { paneA, fileTabs, sessions, repos, shipOrders, coarseNow, setSelectedIssueId, trpc } =
    useStoreSelector(
      (s) => ({
        paneA: s.paneA,
        fileTabs: s.fileTabs,
        sessions: s.sessions,
        repos: s.repos,
        shipOrders: s.shipOrders,
        coarseNow: s.coarseNow,
        setSelectedIssueId: s.setSelectedIssueId,
        trpc: s.trpc,
      }),
      shallowEqual,
    )
  const issues = useReplicaIssues()
  const { setFocusedIssueId } = useOperatorFocus()
  const active = useMemo(
    () => resolveActiveWorktree({ paneA, fileTabs, sessions }),
    [paneA, fileTabs, sessions],
  )
  const shippingCommands = useMemo<ShippingPanelCommands>(
    () => ({
      resolveHold: (input) => trpc.issues.resolveShipHold.mutate(input),
      cancelOrder: (input) => trpc.issues.cancelShip.mutate(input),
      getReceipt: (input) => trpc.issues.deliveryReceipt.query(input),
    }),
    [trpc],
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
            <Suspense fallback={<span className="min-w-0 flex-1" aria-hidden="true" />}>
              <RightDockIssuePanel kind="crumbs" />
            </Suspense>
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
        <Suspense fallback={<DockPanelFallback />}>
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
              <RightDockIssuePanel kind="explorer" cwd={active.cwd} machineId={active.machineId} />
            ) : (
              <RightDockIssuePanel kind="explorer" cwd="" />
            ))}
          {tab === 'superagent' && <SuperagentView />}
          {tab === 'shell' &&
            (active ? (
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
          {tab === 'shipping' && (
            <ShippingPanel
              orders={shipOrders}
              issues={issues}
              repoId={mergeQueueScope?.repoId ?? null}
              now={coarseNow}
              commands={shippingCommands}
            />
          )}
        </Suspense>
      </div>
    </DockHeaderSlotProvider>
  )
}
