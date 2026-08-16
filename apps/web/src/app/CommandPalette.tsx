import type { SpawnTarget } from '@podium/client-core'
import { shallowEqual } from '@podium/client-core/store'
import {
  issueReferenceModel,
  lastUsedMaps,
  panelLabel,
  type RepoNavView,
  reposToViews,
  resolveDefaultAgent,
  spawnTargetForRepo,
  worklistSlice,
} from '@podium/client-core/viewmodels'
import type { AgentKind, IssueId, IssueWire, SessionId } from '@podium/model/browser'
import { isSnoozed, snoozeUntil1h, snoozeUntilTomorrow5am } from '@podium/model/browser'
import { resolveRole } from '@podium/runtime'
import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  BarChart3,
  Bot,
  CalendarClock,
  Clipboard,
  FileText,
  FolderPlus,
  GitBranch,
  LayoutPanelLeft,
  Mail,
  MailOpen,
  MessageSquareText,
  Moon,
  PanelRightClose,
  Play,
  Search,
  Settings,
  SlidersHorizontal,
  SquareKanban,
  SquarePlus,
  Workflow,
  X,
} from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { openAddProject } from '@/app/desktop-menu'
import { IssueReference } from '@/components/IssueReference'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { STAGE_LABELS } from '@/features/issues/issue-card'
import { paletteIssueMenuData } from '@/features/issues/issue-menu-palette'
import { issueMenuPaletteCommands } from '@/features/issues/issue-menu-palette-commands'
import { NewIssueDialog } from '@/features/issues/NewIssueDialog'
import { SETTINGS_TABS } from '@/features/settings/SettingsView'
import { agentIconFor } from '@/lib/agent-tone'
import { useSessionGuard } from '@/lib/hooks/use-session-guard'
import { AgentStatusGlyph, BrailleSpinner } from '@/lib/motion'
import { sessionMenuEligibility } from '@/lib/session-context-menu'
import { useFeature } from '@/lib/use-feature'
import { sessionDisplayName } from '@/lib/WorkerLabel'
import {
  defaultHighlight,
  filterCommands,
  flattenGroups,
  GROUP_CAP,
  isResting,
  moveHighlight,
  type PaletteCommand,
  type PaletteGroup,
  type PaletteGroupId,
  type PaletteIcon,
} from './command-palette'
import { RIGHT_PANELS } from './RightDock'
import {
  CLOSE_RIGHT_PANEL,
  OPEN_RIGHT_PANEL_EVENT,
  type RightPanelTab,
  rightPanelAllowed,
} from './shell-state'
import { type MainView, useReplicaIssues, useSlice, useStoreSelector } from './store'

const SEARCH_DEBOUNCE_MS = 150
const SEARCH_MIN_QUERY_LEN = 2

/**
 * Debounced, race-guarded issue search over `trpc.issues.search` — merged into
 * the local task results once the query is ≥2 chars. Failures degrade silently
 * to local-only.
 *
 * `pending` is the palette's one licensed piece of perpetual motion: the field
 * runs the braille spinner while — and only while — a search is genuinely in
 * flight, which is the same predicate the agent-state grammar gates on.
 */
function useIssueSearch(query: string, enabled: boolean): { hits: IssueWire[]; pending: boolean } {
  const trpc = useStoreSelector((s) => s.trpc)
  const [hits, setHits] = useState<IssueWire[]>([])
  const [pending, setPending] = useState(false)
  const seq = useRef(0)
  useEffect(() => {
    const text = query.trim()
    const mySeq = ++seq.current
    if (!enabled || text.length < SEARCH_MIN_QUERY_LEN) {
      setPending(false)
      setHits((h) => (h.length === 0 ? h : []))
      return
    }
    const t = setTimeout(() => {
      setPending(true)
      trpc.issues.search
        .query({ text })
        .then((rows) => {
          if (seq.current === mySeq) {
            setHits(rows)
            setPending(false)
          }
        })
        .catch(() => {
          // Silent degrade: local task results still render.
          if (seq.current === mySeq) {
            setPending(false)
            setHits((h) => (h.length === 0 ? h : []))
          }
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [trpc, query, enabled])
  return { hits, pending }
}

/**
 * App-wide Cmd/Ctrl+K command palette. Mounted once at shell level; the store's
 * `paletteOpen` drives it. See `command-palette.ts` for the grouping model and
 * `.cmdk-*` in styles.css for the surface.
 */
export function CommandPalette(): JSX.Element {
  const { paletteOpen, setPaletteOpen } = useStoreSelector(
    (s) => ({ paletteOpen: s.paletteOpen, setPaletteOpen: s.setPaletteOpen }),
    shallowEqual,
  )
  // These flows outlive the palette (which closes on execute), so they live
  // here as siblings rather than inside the palette dialog.
  const [newIssueOpen, setNewIssueOpen] = useState(false)
  return (
    <>
      {paletteOpen && (
        <PaletteDialog
          onClose={() => setPaletteOpen(false)}
          onNewIssue={() => setNewIssueOpen(true)}
          onAddRepo={openAddProject}
        />
      )}
      {newIssueOpen && <NewIssueDialog onClose={() => setNewIssueOpen(false)} />}
    </>
  )
}

/** Static group names. `on-task` / `on-agent` name their subject instead. */
const GROUP_LABEL: Record<PaletteGroupId, string> = {
  recent: 'Recent',
  task: 'Tasks',
  agent: 'Agents',
  place: 'Worktrees',
  'on-task': 'Task',
  'on-agent': 'Agent',
  action: 'Actions',
}

function PaletteDialog({
  onClose,
  onNewIssue,
  onAddRepo,
}: {
  onClose: () => void
  onNewIssue: () => void
  onAddRepo: () => void
}): JSX.Element {
  const {
    trpc,
    repos,
    sessions,
    machines,
    markIssueRead,
    markIssueUnread,
    updateIssue,
    deleteIssue,
    closeIssue,
    deferIssue,
    undeferIssue,
    setIssueLabels,
    restoreIssue,
    markSessionRead,
    markSessionUnread,
    openIssueId,
    pins,
    paneA,
    setPane,
    setView,
    setSettingsTab,
    setSelectedWorktree,
    setSelectedIssueId,
    setOpenIssueId,
    selectedIssueId,
    setSnooze,
    clearSnooze,
    hibernateSession,
    resurrectSession,
    startBtw,
    selectedWorktree,
    spawnDraftAgent,
  } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      repos: s.repos,
      sessions: s.sessions,
      machines: s.machines,
      markIssueRead: s.markIssueRead,
      markIssueUnread: s.markIssueUnread,
      updateIssue: s.updateIssue,
      deleteIssue: s.deleteIssue,
      closeIssue: s.closeIssue,
      deferIssue: s.deferIssue,
      undeferIssue: s.undeferIssue,
      setIssueLabels: s.setIssueLabels,
      restoreIssue: s.restoreIssue,
      markSessionRead: s.markSessionRead,
      markSessionUnread: s.markSessionUnread,
      openIssueId: s.openIssueId,
      pins: s.pins,
      paneA: s.paneA,
      setPane: s.setPane,
      setView: s.setView,
      setSettingsTab: s.setSettingsTab,
      setSelectedWorktree: s.setSelectedWorktree,
      setSelectedIssueId: s.setSelectedIssueId,
      setOpenIssueId: s.setOpenIssueId,
      selectedIssueId: s.selectedIssueId,
      setSnooze: s.setSnooze,
      clearSnooze: s.clearSnooze,
      hibernateSession: s.hibernateSession,
      resurrectSession: s.resurrectSession,
      startBtw: s.startBtw,
      selectedWorktree: s.selectedWorktree,
      spawnDraftAgent: s.spawnDraftAgent,
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const { guardedKill, guardedArchive } = useSessionGuard()
  const workflowsEnabled = useFeature('workflows')
  const specsEnabled = useFeature('specs')
  const automationsEnabled = useFeature('automations')
  const notificationsEnabled = useFeature('notifications')
  const handoffEnabled = useFeature('session-handoff')
  const gitPanelEnabled = useFeature('git-panel')
  const messagesPanelEnabled = useFeature('messages-panel')
  const mergeQueueEnabled = useFeature('merge-queue')
  const shippingEnabled = useFeature('shipping')
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)
  // Only a keyboard move scrolls the list. Scrolling because the POINTER
  // crossed a half-visible row moves that row out from under the cursor, which
  // fires another mousemove: the list walks itself while the hand is still.
  const scrollOnHighlight = useRef(false)

  // The user's persisted default agent — same source the sidebar button reads.
  const [agentSetting, setAgentSetting] = useState<string | undefined>(undefined)
  useEffect(() => {
    let alive = true
    void trpc.settings.get
      .query()
      .then((s) => {
        if (alive) setAgentSetting(resolveRole(s, 'coding').harness)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [trpc])

  const { hits: serverIssueHits, pending: searching } = useIssueSearch(query, true)
  const resting = isResting(query)

  // Spawn targets for "New agent": the currently selected worktree AND the
  // sidebar "New <Agent> in <Repo>" button's default (the most recently active
  // repo's primary worktree) — both offered when they differ.
  const defaultAgent: AgentKind = resolveDefaultAgent(agentSetting, sessions)
  // THE SECOND CONSUMER (POD-331). This used to call `sidebarSections` itself,
  // with a bare `Date.now()` that only advanced when the unrelated memo deps
  // below changed — so the palette and the sidebar derived the same worklist
  // twice, against two different clocks. It now reads the published slice: one
  // derivation per snapshot, shared, on the store's coarse clock.
  const sections = useSlice(worklistSlice).sections
  const spawnTargets = useMemo((): SpawnTarget[] => {
    const worktrees = reposToViews(repos).flatMap((r) => r.worktrees)
    const current = worktrees.find((w) => w.path === selectedWorktree)
    const { byRepo } = lastUsedMaps(sections, sessions)
    const repoNavs: RepoNavView[] = [...sections.pinnedRepos, ...sections.repos]
    const defaultRepo = repoNavs.reduce<RepoNavView | undefined>(
      (best, r) =>
        best === undefined || (byRepo.get(r.path) ?? 0) > (byRepo.get(best.path) ?? 0) ? r : best,
      undefined,
    )
    const primary = defaultRepo ? spawnTargetForRepo(defaultRepo).worktree : undefined
    const out: SpawnTarget[] = []
    if (current) out.push(current)
    if (primary && primary.path !== current?.path) out.push(primary)
    return out
  }, [repos, sessions, sections, selectedWorktree])

  /** Close the palette, then run — optimistic close; errors toast downstream. */
  const execute = (run: () => void | Promise<void>): void => {
    onClose()
    void run()
  }

  const openSession = (sessionId: SessionId, cwd: string, issueId?: IssueId): void => {
    // A draft spawn passes its issue id so the draft-agent row is selected; plain
    // session navigation passes none (worktree selection, issue cleared).
    setSelectedIssueId(issueId ?? null)
    setSelectedWorktree(cwd)
    setPane('A', sessionId)
    setView('workspace')
  }

  const issueMenuData = useMemo(
    () =>
      paletteIssueMenuData({
        issues,
        issueId: openIssueId ?? selectedIssueId,
        sessions,
        repos,
        machines,
        handoffEnabled,
      }),
    [issues, openIssueId, selectedIssueId, sessions, repos, machines, handoffEnabled],
  )

  const focused = paneA ? sessions.find((s) => s.sessionId === paneA) : undefined

  // biome-ignore lint/correctness/useExhaustiveDependencies: run closures capture stable store actions
  const commands = useMemo((): PaletteCommand[] => {
    const out: PaletteCommand[] = []

    const sessionCommand = (
      s: (typeof sessions)[number],
      group: 'recent' | 'agent',
    ): PaletteCommand => ({
      id: `${group}-session:${s.sessionId}`,
      group,
      label: sessionDisplayName(s),
      keywords: [s.cwd.split('/').pop() ?? s.cwd, s.agentKind, 'agent', 'session'],
      hint: s.cwd.split('/').pop(),
      session: s,
      run: () => openSession(s.sessionId, s.cwd),
    })
    const issueCommand = (i: IssueWire, group: 'recent' | 'task'): PaletteCommand => ({
      id: `${group}-issue:${i.id}`,
      group,
      label: i.title,
      keywords: ['task', 'issue', i.displayRef ?? `#${i.seq}`, STAGE_LABELS[i.stage]],
      issueReference: issueReferenceModel(i),
      run: () => {
        setOpenIssueId(i.id)
        setView('issues')
      },
    })

    // ── Recent: the resting state's whole answer ──────────────────────────
    // Agents by last activity, tasks by last touch, merged and cut to the cap.
    // This is the ONE place the palette ranks by time rather than by match, and
    // it exists because "what was I just doing" is the question ⌘K is opened
    // with when there is nothing typed yet.
    const stamp = (iso: string | undefined): number => (iso ? Date.parse(iso) || 0 : 0)
    const recent: { at: number; cmd: PaletteCommand }[] = []
    for (const s of sessions) {
      if (s.archived) continue
      recent.push({ at: stamp(s.lastActiveAt), cmd: sessionCommand(s, 'recent') })
    }
    for (const i of issues) {
      if (i.archived || i.deletedAt || i.draft) continue
      recent.push({ at: stamp(i.updatedAt), cmd: issueCommand(i, 'recent') })
    }
    recent.sort((a, b) => b.at - a.at)
    for (const r of recent.slice(0, GROUP_CAP.recent.rest)) out.push(r.cmd)

    // ── Tasks (local replica + server search hits, deduped) ───────────────
    const localIds = new Set<string>()
    for (const i of issues) {
      if (i.archived || i.deletedAt || i.draft) continue
      localIds.add(i.id)
      out.push(issueCommand(i, 'task'))
    }
    for (const i of serverIssueHits) {
      if (!localIds.has(i.id)) out.push(issueCommand(i, 'task'))
    }

    // ── Agents ────────────────────────────────────────────────────────────
    for (const s of sessions) {
      if (s.archived) continue
      out.push(sessionCommand(s, 'agent'))
    }

    // ── Worktrees ─────────────────────────────────────────────────────────
    for (const repo of reposToViews(repos)) {
      for (const w of repo.worktrees) {
        out.push({
          id: `place:${w.path}`,
          group: 'place',
          label: w.branch ?? (w.path.split('/').pop() || w.path),
          keywords: [repo.name, 'worktree', 'branch', w.path],
          hint: repo.name,
          icon: GitBranch,
          run: () => {
            setSelectedIssueId(null)
            setSelectedWorktree(w.path)
            setView('workspace')
          },
        })
      }
    }

    // ── Actions on the selected task ──────────────────────────────────────
    if (issueMenuData) {
      out.push(
        ...issueMenuPaletteCommands(issueMenuData, {
          trpc,
          markIssueRead,
          markIssueUnread,
          updateIssue,
          deleteIssue,
          closeIssue,
          deferIssue,
          undeferIssue,
          setIssueLabels,
          restoreIssue,
          setOpenIssueId: (id) => setOpenIssueId(id as IssueId),
          setView: (view) => setView(view),
          handoff: (machineId) => {
            const sessionId = issueMenuData.handoff?.sessionId
            if (sessionId) void trpc.sessions.handoff.mutate({ sessionId, machineId })
          },
        }),
      )
    }

    // ── Actions on the focused agent — the context menu's own gates ───────
    if (focused) {
      const id = focused.sessionId
      const { canHibernate, canResume, canClose, canMarkRead, canMarkUnread } =
        sessionMenuEligibility(focused)
      const snoozed = isSnoozed(focused, Date.now())
      const sess = (cmd: Omit<PaletteCommand, 'group'>): void => {
        out.push({ ...cmd, group: 'on-agent' })
      }
      if (canMarkUnread)
        sess({
          id: 'session:mark-unread',
          label: 'Mark as unread',
          icon: Mail,
          run: () => markSessionUnread(id),
        })
      if (canMarkRead)
        sess({
          id: 'session:mark-read',
          label: 'Mark as read',
          icon: MailOpen,
          run: () => markSessionRead(id),
        })
      if (snoozed) {
        sess({
          id: 'session:unsnooze',
          label: 'Un-snooze',
          icon: AlarmClockOff,
          run: () => clearSnooze(id),
        })
      } else {
        sess({
          id: 'session:snooze-1h',
          label: 'Snooze for 1 hour',
          icon: AlarmClock,
          run: () => setSnooze(id, snoozeUntil1h(Date.now())),
        })
        sess({
          id: 'session:snooze-tomorrow',
          label: 'Snooze until tomorrow',
          icon: AlarmClock,
          run: () => setSnooze(id, snoozeUntilTomorrow5am(Date.now())),
        })
        sess({
          id: 'session:snooze-next',
          label: 'Snooze until next message',
          icon: AlarmClock,
          run: () => setSnooze(id, null),
        })
      }
      if (canHibernate)
        sess({
          id: 'session:hibernate',
          label: 'Hibernate',
          icon: Moon,
          run: () => hibernateSession(id),
        })
      if (canResume)
        sess({
          id: 'session:resume',
          label: 'Resume',
          icon: Play,
          run: () => {
            void resurrectSession(id)
          },
        })
      sess({
        id: 'session:btw',
        label: 'Ask superagent (BTW)',
        keywords: ['btw', 'superagent'],
        icon: MessageSquareText,
        run: () => startBtw(id),
      })
      sess({
        id: 'session:archive',
        label: focused.archived ? 'Unarchive' : 'Archive',
        icon: focused.archived ? ArchiveRestore : Archive,
        run: () => guardedArchive(id, !focused.archived),
      })
      if (canClose)
        sess({
          id: 'session:close',
          label: 'Close',
          keywords: ['kill', 'stop', 'end session'],
          icon: X,
          run: () => guardedKill(id),
        })
      sess({
        id: 'session:copy-id',
        label: 'Copy session id',
        icon: Clipboard,
        run: () => navigator.clipboard?.writeText(id).catch(() => {}),
      })
    }

    // ── Actions: create ───────────────────────────────────────────────────
    out.push({
      id: 'action:new-task',
      group: 'action',
      label: 'New task',
      keywords: ['create', 'add', 'issue'],
      icon: SquarePlus,
      run: onNewIssue,
    })
    for (const target of spawnTargets) {
      out.push({
        id: `action:new-agent:${target.path}`,
        group: 'action',
        label: `New ${panelLabel(defaultAgent)} agent in ${target.path.split('/').pop()}`,
        keywords: ['session', 'spawn', 'start', 'new agent'],
        icon: agentIconFor(defaultAgent) ?? Bot,
        run: () => {
          // Optimistic (#119): the store paints the row instantly; navigate now.
          const { sessionId, issueId } = spawnDraftAgent({ target, agentKind: defaultAgent })
          openSession(sessionId, target.path, issueId)
        },
      })
    }
    out.push({
      id: 'action:add-repo',
      group: 'action',
      label: 'Add repo…',
      keywords: ['repository', 'project', 'scan', 'clone', 'folder'],
      icon: FolderPlus,
      run: onAddRepo,
    })

    // ── Actions: go to ────────────────────────────────────────────────────
    const views: [MainView, string, string[], PaletteIcon][] = [
      ['workspace', 'Go to Work', ['workspace', 'terminal', 'agents'], LayoutPanelLeft],
      ['issues', 'Go to Tasks', ['kanban', 'board', 'tracker', 'issues'], SquareKanban],
      ['workflows', 'Go to Workflows', ['process', 'steps'], Workflow],
      ['specs', 'Go to Specs', ['living spec', 'sp-'], FileText],
      ['automations', 'Go to Automations', ['schedule', 'cron', 'routine'], CalendarClock],
      ['usage', 'Go to Usage', ['quota', 'cost', 'analytics', 'spend'], BarChart3],
      ['settings', 'Go to Settings', ['preferences', 'config'], Settings],
    ]
    for (const [view, label, keywords, icon] of views) {
      if (view === 'workflows' && !workflowsEnabled) continue
      if (view === 'specs' && !specsEnabled) continue
      if (view === 'automations' && !automationsEnabled) continue
      out.push({
        id: `action:view-${view}`,
        group: 'action',
        label,
        keywords: [...keywords, 'switch', 'view', 'go to'],
        icon,
        run: () => setView(view),
      })
    }

    // ── Actions: the right dock ───────────────────────────────────────────
    // Every panel has a cell in the right rail and, until now, exactly one of
    // them ("the superagent panel") had a palette route. The rail's own list is
    // the source, so a new panel arrives here for free.
    const panelAllowed = (panel: RightPanelTab): boolean =>
      rightPanelAllowed(panel, {
        git: gitPanelEnabled,
        messages: messagesPanelEnabled,
        mergeQueue: mergeQueueEnabled,
        shipping: shippingEnabled,
      })
    for (const panel of RIGHT_PANELS) {
      if (!panelAllowed(panel.id)) continue
      out.push({
        id: `action:panel-${panel.id}`,
        group: 'action',
        label: `Open ${panel.label} panel`,
        keywords: ['dock', 'panel', 'side', panel.label],
        icon: panel.icon,
        run: () => openRightPanel(panel.id),
      })
    }
    out.push({
      id: 'action:panel-close',
      group: 'action',
      label: 'Close side panel',
      keywords: ['dock', 'hide', 'panel'],
      icon: PanelRightClose,
      run: () => openRightPanel(null),
    })

    // ── Actions: settings destinations ────────────────────────────────────
    for (const tab of SETTINGS_TABS) {
      if (tab.key === 'notifications' && !notificationsEnabled) continue
      out.push({
        id: `action:settings-${tab.key}`,
        group: 'action',
        label: `Settings · ${tab.label}`,
        keywords: ['settings', 'preferences', 'config', tab.label],
        icon: SlidersHorizontal,
        run: () => setSettingsTab(tab.key),
      })
    }

    return out
  }, [
    sessions,
    repos,
    issues,
    serverIssueHits,
    pins,
    focused,
    spawnTargets,
    defaultAgent,
    workflowsEnabled,
    specsEnabled,
    automationsEnabled,
    notificationsEnabled,
    gitPanelEnabled,
    messagesPanelEnabled,
    mergeQueueEnabled,
    handoffEnabled,
    issueMenuData,
  ])

  const groups = useMemo(() => filterCommands(query, commands), [query, commands])
  const flat = useMemo(() => flattenGroups(groups), [groups])
  // The free-text fallback ("spawn an agent with what I typed") is a QUERY row:
  // with nothing typed it would only restate the Actions group's own "New …
  // agent in <worktree>", which is the same spawn with an empty first prompt.
  const fallbackTargets = resting ? [] : spawnTargets
  const rowCount = flat.length + fallbackTargets.length

  // Re-highlight the top result whenever the result set changes.
  useEffect(() => {
    setHighlight(defaultHighlight(flat.length))
  }, [flat])

  // Keep the highlighted row visible as the roving selection moves.
  useEffect(() => {
    if (!scrollOnHighlight.current) return
    scrollOnHighlight.current = false
    listRef.current
      ?.querySelector(`#palette-item-${highlight}`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  const runFallback = (target: SpawnTarget): void => {
    const text = query.trim()
    execute(() => {
      const { sessionId, issueId } = spawnDraftAgent({
        target,
        agentKind: defaultAgent,
        firstPrompt: text || undefined,
      })
      openSession(sessionId, target.path, issueId)
    })
  }

  const runRow = (index: number): void => {
    const cmd = flat[index]
    if (cmd) execute(cmd.run)
    else {
      const target = fallbackTargets[index - flat.length]
      if (target) runFallback(target)
    }
  }

  const onInputKeyDown = (e: React.KeyboardEvent): void => {
    const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'n')
    const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key.toLowerCase() === 'p')
    if (down || up) {
      e.preventDefault()
      scrollOnHighlight.current = true
      setHighlight((i) => moveHighlight(i, down ? 1 : -1, rowCount))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runRow(highlight)
    } else if (e.key === 'Escape' && query) {
      // Two-stage escape (cmdk-style): first clears the query, second closes.
      e.preventDefault()
      e.stopPropagation()
      setQuery('')
    }
  }

  const taskSubject = issueMenuData ? issueReferenceModel(issueMenuData.first).ref : undefined
  const agentSubject = focused ? sessionDisplayName(focused) : undefined
  const groupHeading = (group: PaletteGroup): string => {
    if (group.group === 'on-task' && taskSubject) return `Task · ${taskSubject}`
    if (group.group === 'on-agent' && agentSubject) return `Agent · ${agentSubject}`
    return GROUP_LABEL[group.group]
  }

  let rowIndex = 0
  const row = (cmd: PaletteCommand): JSX.Element => {
    const idx = rowIndex++
    return (
      <PaletteRow
        key={cmd.id}
        cmd={cmd}
        index={idx}
        active={idx === highlight}
        onHover={() => setHighlight(idx)}
        onRun={() => runRow(idx)}
      />
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent
        aria-label="Command palette"
        showCloseButton={false}
        position="viewport"
        className="cmdk-panel"
      >
        <div className="cmdk-surface">
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          {/* THE FIELD IS THE WELL. The command bar's signature control — a groove
            carved into the chassis, lit along its lower lip — at full width.
            The palette IS the command bar, arrived at the centre of the screen;
            wearing the bar's own material is what says so. */}
          <div className="cmdk-field">
            <Search size={15} className="cmdk-field-glyph" aria-hidden="true" />
            <input
              autoFocus
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-listbox"
              aria-activedescendant={rowCount > 0 ? `palette-item-${highlight}` : undefined}
              placeholder="Search tasks, agents and commands…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKeyDown}
              className="cmdk-input"
            />
            {searching && <BrailleSpinner size={11} className="cmdk-field-spinner" />}
          </div>
          <div
            ref={listRef}
            id="palette-listbox"
            role="listbox"
            aria-label="Commands"
            className="cmdk-list"
          >
            {groups.map((g) => (
              <div key={g.group} role="group" aria-label={groupHeading(g)} className="cmdk-group">
                <div className="cmdk-group-label" aria-hidden="true">
                  <span className="cmdk-group-name">{groupHeading(g)}</span>
                  {g.total > g.commands.length && (
                    <span className="cmdk-group-count">
                      {g.commands.length}/{g.total}
                    </span>
                  )}
                </div>
                {g.commands.map(row)}
              </div>
            ))}
            {/* Free-text fallback — always the last rows, and the ONLY rows when a
              query matches nothing: spawn an agent with the query as its first
              prompt, one row per target (current worktree / last repo's). */}
            {/* A search that found nothing has to SAY so. With spawn targets
              present the fallback rows keep the list non-empty, so the designed
              empty state below never fires — and a lone "NEW AGENT" heading
              looks like a result, not like the end of the road. */}
            {flat.length === 0 && fallbackTargets.length > 0 && (
              <p className="cmdk-nomatch">No match for “{query.trim()}”</p>
            )}
            {fallbackTargets.length > 0 && (
              <div role="group" aria-label="New agent" className="cmdk-group">
                <div className="cmdk-group-label" aria-hidden="true">
                  <span className="cmdk-group-name">New agent</span>
                </div>
                {fallbackTargets.map((target) => {
                  const idx = rowIndex++
                  return (
                    <button
                      data-pressable
                      key={target.path}
                      id={`palette-item-${idx}`}
                      type="button"
                      role="option"
                      aria-selected={idx === highlight}
                      tabIndex={-1}
                      className="cmdk-row"
                      data-active={idx === highlight || undefined}
                      onMouseMove={() => setHighlight(idx)}
                      onClick={() => runRow(idx)}
                    >
                      <span className="cmdk-row-lead" aria-hidden="true">
                        <Bot size={15} />
                      </span>
                      <span className="cmdk-row-title">
                        New agent{query.trim() ? `: “${query.trim()}”` : ''}
                      </span>
                      <span className="cmdk-row-hint">{target.path.split('/').pop()}</span>
                      <PaletteEnterCap />
                    </button>
                  )
                })}
              </div>
            )}
            {rowCount === 0 && (
              <div className="cmdk-empty">
                <p className="cmdk-empty-label">No match</p>
                <p className="cmdk-empty-text">
                  Nothing here answers “{query.trim()}”. Add a repo to start an agent from a search.
                </p>
              </div>
            )}
          </div>
          {/* The status strip's grammar, borrowed: mono at label scale on --bar,
            closing the surface the way the shell's own bottom edge closes the
            window. It is also where the ⌘K hint that used to sit in the app's
            footer all day now lives — stated once, while it is useful. */}
          <div className="cmdk-foot">
            <span className="cmdk-keys">
              <kbd>↑↓</kbd>
              <span>move</span>
              <kbd>↵</kbd>
              <span>run</span>
              <kbd>esc</kbd>
              <span>{query ? 'clear' : 'close'}</span>
            </span>
            <span className="cmdk-count">
              {resting
                ? `${commands.length} commands`
                : `${rowCount} ${rowCount === 1 ? 'match' : 'matches'}`}
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The one yellow thing in the palette: what Enter will do, on the row it will
 *  do it to. Reserved space on every row so the hint column never jitters as
 *  the highlight moves. */
function PaletteEnterCap(): JSX.Element {
  return (
    <span className="cmdk-row-cap" aria-hidden="true">
      ↵
    </span>
  )
}

function PaletteRow({
  cmd,
  index,
  active,
  onHover,
  onRun,
}: {
  cmd: PaletteCommand
  index: number
  active: boolean
  onHover: () => void
  onRun: () => void
}): JSX.Element {
  const Icon = cmd.icon
  return (
    <button
      data-pressable
      id={`palette-item-${index}`}
      type="button"
      role="option"
      aria-selected={active}
      tabIndex={-1}
      className="cmdk-row"
      data-active={active || undefined}
      onMouseMove={onHover}
      onClick={onRun}
    >
      {cmd.issueReference ? (
        <IssueReference
          model={cmd.issueReference}
          size={14}
          className="cmdk-row-issue"
          refClassName="cmdk-row-ref"
          titleClassName="cmdk-row-title"
        />
      ) : (
        <>
          <span className="cmdk-row-lead" aria-hidden="true">
            {Icon ? <Icon size={15} /> : null}
          </span>
          <span className="cmdk-row-title">{cmd.label}</span>
        </>
      )}
      {cmd.session && <AgentStatusGlyph session={cmd.session} variant="row" />}
      {cmd.hint && <span className="cmdk-row-hint">{cmd.hint}</span>}
      <PaletteEnterCap />
    </button>
  )
}

/** Ask the shell for a dock panel; `null` closes it. The panel state is
 *  AppShell-local, so this crosses by window event like the git stamp does. */
function openRightPanel(panel: RightPanelTab | null): void {
  window.dispatchEvent(
    new CustomEvent(OPEN_RIGHT_PANEL_EVENT, { detail: panel ?? CLOSE_RIGHT_PANEL }),
  )
}
