import { shallowEqual } from '@podium/client-core/store'
import type { IssueWire, SessionMeta } from '@podium/protocol'
import {
  ChevronDown,
  FileText,
  Home,
  KanbanSquare,
  ListChecks,
  Pin,
  Sparkles,
  X,
} from 'lucide-react'
import type { JSX } from 'react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { HostIndicators } from '@/features/machines/HostIndicators'
import { SuperagentView } from '@/features/superagent/SuperagentView'
import { AgentPanel } from '@/features/terminal/AgentPanel'
import { AppToolsRow, NewWorkRow, WorkSections } from '@/features/worklist/SidebarUnified'
import {
  draftIssueLabel,
  orderTabs,
  reposToViews,
  sessionDotClass,
  sessionsForIssueNav,
  sessionsForWorktree,
} from '@/lib/derive'
import { useSessionGuard } from '@/lib/hooks/use-session-guard'
import { cn } from '@/lib/utils'
import { WorkerLabel } from '@/lib/WorkerLabel'
import { NewPanelMenu } from './NewPanelMenu'
import { MainViewOutlet } from './routes'
import { type FileTab, useStoreSelector } from './store'
import type { WorktreeView } from './types'

// File viewer (clickable transcript paths) — lazy, mirroring the desktop Workspace.
const FilePanel = lazy(() =>
  import('@/features/files/FilePanel').then((m) => ({ default: m.FilePanel })),
)

/** A panel of the selected work: an agent/shell session, or an open file tab. */
type MobilePanel =
  | { kind: 'session'; id: string; session: SessionMeta }
  | { kind: 'file'; id: string; tab: FileTab }

function basename(path: string): string {
  return path.split('/').pop() || path
}

/**
 * Pin the mobile shell to the visual viewport. The layout viewport (what dvh
 * tracks) does not shrink when the soft keyboard opens on iOS, so a bottom-anchored
 * key bar would hide behind the keyboard. Tracking visualViewport.height into
 * --viewport-h shrinks the shell to the visible area, leaving the key bar flush
 * above the keyboard. No-op where visualViewport is unavailable.
 */
function useVisualViewportHeight(): void {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    // iOS scrolls the document when the keyboard opens or when a drag escapes a
    // scrollable region, sliding the shell up and exposing blank page below it.
    // The shell is sized to the visual viewport, so document scroll is never
    // legitimate — snap it back.
    const pin = () => {
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0)
    }
    const apply = () => {
      root.style.setProperty('--viewport-h', `${Math.round(vv.height)}px`)
      // The soft keyboard eats the bottom of the visual viewport, and while it's up
      // the home-indicator safe area is hidden behind it — so reserving safe-area
      // padding on the bottom key bar then just leaves a dead gap above the keyboard.
      // Flag keyboard-open (layout viewport minus visual viewport > a threshold the
      // URL-bar can't reach) so the bar drops that padding (see --kb-open in CSS).
      const kbOpen = (window.innerHeight || vv.height) - vv.height > 150
      root.style.setProperty('--kb-open', kbOpen ? '1' : '0')
      pin()
    }
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    window.addEventListener('scroll', pin)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      window.removeEventListener('scroll', pin)
      root.style.removeProperty('--viewport-h')
      root.style.removeProperty('--kb-open')
    }
  }, [])
}

/**
 * Mobile home (#227): the desktop sidebar minus the nav column the mobile header
 * already provides. Rows run the sidebar's own handlers, so a tap selects the
 * issue, opens one of its panes, and navigates to the workspace.
 */
function MobileHomeView(): JSX.Element {
  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-y-auto pb-6">
      <NewWorkRow />
      <AppToolsRow className="mx-3 mt-2" />
      <div className="mt-1">
        <WorkSections />
      </div>
    </section>
  )
}

export function MobileApp(): JSX.Element {
  useVisualViewportHeight()
  const {
    sessions,
    pins,
    setPinned,
    issues,
    selectedIssueId,
    selectedWorktree,
    paneA,
    setPane,
    view,
    setView,
    superOpen,
    setSuperOpen,
    fileTabs,
    closeFileTab,
    repos,
    tabOrders,
  } = useStoreSelector(
    (s) => ({
      sessions: s.sessions,
      pins: s.pins,
      setPinned: s.setPinned,
      issues: s.issues,
      selectedIssueId: s.selectedIssueId,
      selectedWorktree: s.selectedWorktree,
      paneA: s.paneA,
      setPane: s.setPane,
      view: s.view,
      setView: s.setView,
      superOpen: s.superOpen,
      setSuperOpen: s.setSuperOpen,
      fileTabs: s.fileTabs,
      closeFileTab: s.closeFileTab,
      repos: s.repos,
      tabOrders: s.tabOrders,
    }),
    shallowEqual,
  )
  const { guardedKill } = useSessionGuard()
  const repoViews = useMemo(() => reposToViews(repos), [repos])
  const allWorktreePaths = useMemo(
    () => repoViews.flatMap((r) => r.worktrees.map((w) => w.path)),
    [repoViews],
  )
  const selectedIssue: IssueWire | undefined = selectedIssueId
    ? issues.find((i) => i.id === selectedIssueId)
    : undefined
  // The worktree behind the selection: the issue's own, else the bare worktree
  // row the user picked. A draft issue has none until its agent lands somewhere.
  const worktreePath = selectedIssue?.worktreePath ?? selectedWorktree
  const worktree = repoViews.flatMap((r) => r.worktrees).find((w) => w.path === worktreePath)
  const worktreeRepoName = worktree
    ? (repoViews.find((r) => r.path === worktree.repoPath)?.name ??
      worktree.repoPath.split('/').pop())
    : null
  // Where the "+" menu spawns, mirroring the desktop workspace: the selection's
  // worktree, or — for a worktree-less issue (a draft) — its repo's primary
  // checkout. The panel is spawned INTO the issue (`issueId`), so it lands in
  // the issue's panel list rather than orbiting a worktree the issue doesn't own.
  const panelTarget: WorktreeView | undefined = selectedIssue
    ? (worktree ??
      repoViews
        .flatMap((r) => r.worktrees)
        .find((w) => w.repoPath === selectedIssue.repoPath && w.isMain) ?? {
        path: selectedIssue.repoPath,
        repoPath: selectedIssue.repoPath,
        isMain: true,
      })
    : worktree

  // Every panel of the selected work: its sessions (agents AND shells) plus the
  // file tabs open on its worktree. A draft issue with no worktree yet still
  // lists its agents. Any future panel kind lands here for free. Memoized: the
  // keep-pane-valid effect below depends on it, and a fresh array every render
  // would re-run that effect on every render.
  const panels: MobilePanel[] = useMemo(() => {
    const panelSessions = selectedIssue
      ? sessionsForIssueNav(selectedIssue, sessions, allWorktreePaths, { includeShells: true })
      : worktreePath
        ? sessionsForWorktree(sessions, worktreePath, allWorktreePaths)
        : []
    // Same manual-order key the desktop workspace strip persists under.
    const orderKey = selectedIssue ? `issue:${selectedIssue.id}` : worktreePath
    return [
      ...orderTabs(panelSessions, orderKey ? tabOrders[orderKey] : undefined, pins).map(
        (session): MobilePanel => ({ kind: 'session', id: session.sessionId, session }),
      ),
      ...(worktreePath
        ? fileTabs
            .filter((f) => f.worktreePath === worktreePath)
            .map((tab): MobilePanel => ({ kind: 'file', id: tab.id, tab }))
        : []),
    ]
  }, [selectedIssue, sessions, allWorktreePaths, worktreePath, tabOrders, pins, fileTabs])

  const [panelMenuOpen, setPanelMenuOpen] = useState(false)
  // The new-agent ("+") menu and the panel-select menu are mutually exclusive —
  // opening one closes the other (#97). Lift the "+" menu's open state here so
  // the two can coordinate (NewPanelMenu is controlled below).
  const [newAgentOpen, setNewAgentOpen] = useState(false)
  // Hold a freshly-opened (or reload-restored) session in pane A until the store
  // knows it — see the keep-pane-valid effect — else it bounces to panels[0].
  const justOpened = useRef<string | null>(paneA)
  // A clicked transcript file path opens a `file:` pane (not a session) — render
  // the file viewer for it instead of an AgentPanel (which would mount a stray
  // shell for the non-session id).
  const activeFileTab =
    paneA?.startsWith('file:') === true ? fileTabs.find((f) => f.id === paneA) : undefined
  const currentPanel = panels.find((p) => p.id === paneA)

  useEffect(() => {
    // A valid `file:` pane is legitimate — don't bounce it to a session panel.
    if (paneA?.startsWith('file:')) {
      if (fileTabs.some((f) => f.id === paneA)) return
      // its tab was closed → fall through to pick a panel
    } else if (paneA && panels.some((p) => p.id === paneA)) {
      justOpened.current = null
      return
    } else if (
      paneA &&
      justOpened.current === paneA &&
      !sessions.some((s) => s.sessionId === paneA)
    ) {
      return
    }
    setPane('A', panels[0]?.id ?? null)
  }, [panels, paneA, setPane, sessions, fileTabs])

  // Any interaction with the work area (tapping into the agent, switching
  // chat/native, starting to type) should dismiss the open work-panel selectors —
  // they otherwise sit over the panel and block it.
  const closePanelMenus = () => {
    setPanelMenuOpen(false)
    setNewAgentOpen(false)
  }
  const openPanel = (id: string) => {
    setPane('A', id)
    setPanelMenuOpen(false)
    setView('workspace')
  }
  // What the header dropdown is anchored to: the selected issue, else the bare
  // worktree, else nothing picked yet (the home list is where work is chosen).
  const selectionTitle = selectedIssue
    ? selectedIssue.draft
      ? draftIssueLabel(selectedIssue, sessions, allWorktreePaths)
      : selectedIssue.title
    : (worktree?.branch ?? worktree?.path.split('/').pop() ?? null)
  const selectionSub = selectedIssue ? (worktree?.branch ?? worktreeRepoName) : worktreeRepoName

  return (
    <div className="mobile-shell relative flex touch-manipulation h-[var(--viewport-h,100dvh)] flex-col">
      <header
        className="flex items-stretch border-b border-border bg-card pt-[var(--safe-top)]"
        style={{ height: 'calc(44px + var(--safe-top))' }}
      >
        <button
          type="button"
          className={cn(
            'inline-flex items-center border-r border-border px-3 text-muted-foreground',
            view === 'home' && 'text-primary',
          )}
          title="Work"
          onClick={() => setView('home')}
        >
          <Home size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={cn(
            'inline-flex items-center border-r border-border px-3 text-muted-foreground',
            superOpen && 'text-primary',
          )}
          title="Superagent"
          aria-pressed={superOpen}
          onClick={() => setSuperOpen(!superOpen)}
        >
          <Sparkles size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={cn(
            'inline-flex items-center border-r border-border px-3 text-muted-foreground',
            view === 'issues' && 'text-primary',
          )}
          title="Issues"
          aria-pressed={view === 'issues'}
          onClick={() => setView('issues')}
        >
          <KanbanSquare size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={cn(
            'inline-flex items-center border-r border-border px-3 text-muted-foreground',
            view === 'workflows' && 'text-primary',
          )}
          title="Workflows"
          aria-pressed={view === 'workflows'}
          onClick={() => setView('workflows')}
        >
          <ListChecks size={15} aria-hidden="true" />
        </button>
        {/* The one main dropdown (#227): the selected issue, opening to its
            panels. It replaced the worktree picker — work is chosen on home. */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center overflow-hidden text-left"
            aria-expanded={panelMenuOpen}
            aria-label="Select panel"
            disabled={panels.length === 0}
            onClick={() =>
              setPanelMenuOpen((v) => {
                // Opening the panel menu closes the "+" menu, and vice versa.
                if (!v) setNewAgentOpen(false)
                return !v
              })
            }
          >
            {selectionTitle ? (
              // w-full on the column (not shrink-to-fit) bounds the truncating
              // lines to the button's width, so a long title ellipsizes instead of
              // overflowing the header. The ▾ caret sits outside the truncating
              // text so it never gets clipped away.
              <span className="flex w-full min-w-0 flex-col items-start leading-[1.15]">
                <span className="w-full truncate text-[10px] tracking-[0.02em] text-muted-foreground">
                  {selectionSub ?? selectionTitle}
                </span>
                <span className="flex w-full min-w-0 items-center gap-1 text-[13px] font-medium text-foreground">
                  {currentPanel?.kind === 'session' && (
                    <span className={sessionDotClass(currentPanel.session)} />
                  )}
                  <span className="truncate">
                    {currentPanel?.kind === 'file'
                      ? basename(currentPanel.tab.path)
                      : selectionTitle}
                  </span>
                  <ChevronDown size={13} className="flex-none" aria-hidden="true" />
                </span>
              </span>
            ) : (
              <span className="text-[13px] text-muted-foreground">Select work</span>
            )}
          </button>
          {/* The menu's own trigger IS the "+" — render it directly. (Previously a
              separate "+" toggled a state that rendered the menu's trigger as a
              second "+", so it took two taps to open.) */}
          {panelTarget && (
            <NewPanelMenu
              worktree={panelTarget}
              {...(selectedIssue ? { issueId: selectedIssue.id } : {})}
              open={newAgentOpen}
              onOpenChange={(o) => {
                setNewAgentOpen(o)
                // Opening the "+" menu closes the panel menu (#97).
                if (o) setPanelMenuOpen(false)
              }}
              onOpened={(sid) => {
                justOpened.current = sid
                setPane('A', sid)
                setView('workspace')
              }}
            />
          )}
        </div>
        <HostIndicators compact />
      </header>
      {panelMenuOpen && panels.length > 0 && (
        // Drops DOWN over the content as an overlay (not in flow) so a long panel
        // list doesn't push the panel down; it caps its height and scrolls when
        // it would otherwise reach the bottom of the screen.
        <div
          className="absolute inset-x-0 z-30 flex max-h-[min(70vh,calc(var(--viewport-h,100dvh)-120px))] flex-col overflow-y-auto border-b border-border bg-muted shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
          style={{ top: 'calc(44px + var(--safe-top))' }}
        >
          {panels.map((panel) => {
            const selectClass = cn(
              'inline-flex min-w-0 flex-1 cursor-pointer items-center gap-2 overflow-hidden whitespace-nowrap p-3 text-left text-[13px]',
              panel.id === paneA ? 'text-foreground' : 'text-muted-foreground',
            )
            if (panel.kind === 'file') {
              return (
                <div
                  key={panel.id}
                  className="flex items-center border-b border-border last:border-b-0"
                >
                  <button type="button" className={selectClass} onClick={() => openPanel(panel.id)}>
                    <FileText size={12} className="flex-none" aria-hidden="true" />
                    <span className="truncate">{basename(panel.tab.path)}</span>
                  </button>
                  <button
                    type="button"
                    className="cursor-pointer px-2.5 py-3 text-[13px] text-muted-foreground/70 hover:text-destructive"
                    title="Close file"
                    aria-label={`Close ${basename(panel.tab.path)}`}
                    onClick={() => closeFileTab(panel.id)}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              )
            }
            const pinned = pins.panels.includes(panel.id)
            return (
              <div
                key={panel.id}
                className="flex items-center border-b border-border last:border-b-0"
              >
                <button type="button" className={selectClass} onClick={() => openPanel(panel.id)}>
                  <span className={sessionDotClass(panel.session)} />{' '}
                  <WorkerLabel session={panel.session} />
                </button>
                <button
                  type="button"
                  className={cn(
                    'cursor-pointer px-2.5 py-3 text-[13px]',
                    pinned ? 'text-primary' : 'text-muted-foreground/70 hover:text-primary',
                  )}
                  aria-pressed={pinned}
                  title={pinned ? 'Unpin panel' : 'Pin panel'}
                  onClick={() => void setPinned('panel', panel.id, !pinned)}
                >
                  <Pin size={12} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="cursor-pointer px-2.5 py-3 text-[13px] text-muted-foreground/70 hover:text-destructive"
                  title="Kill session"
                  onClick={() => void guardedKill(panel.id)}
                >
                  ✕
                </button>
              </div>
            )
          })}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1" onPointerDownCapture={closePanelMenus}>
        <MainViewOutlet
          home={<MobileHomeView />}
          workspace={
            activeFileTab ? (
              <Suspense
                fallback={
                  <div className="m-auto text-[13px] text-muted-foreground/70">Loading…</div>
                }
              >
                <FilePanel
                  scope={activeFileTab.scope}
                  path={activeFileTab.path}
                  onClose={() => closeFileTab(activeFileTab.id)}
                />
              </Suspense>
            ) : paneA ? (
              <AgentPanel sessionId={paneA} />
            ) : (
              <div className="m-auto text-[13px] text-muted-foreground/70">
                No panel - use + to start one.
              </div>
            )
          }
        />
        {/* The superagent overlays the content; collapsing it (its header button,
            or the Sparkles toggle above) minimizes — the Sparkles button pulls it
            back up. */}
        {superOpen && (
          <div className="absolute inset-0 z-20 flex flex-col bg-background">
            <SuperagentView onClose={() => setSuperOpen(false)} />
          </div>
        )}
      </div>
    </div>
  )
}
