import { beginSwitch } from '@podium/client-core/perf'
import { shallowEqual } from '@podium/client-core/store'
import type { IssueColorSlot } from '@podium/domain'
import { type AgentKind, type IssueWire, issueDisplayRef, type SessionMeta } from '@podium/protocol'
import { nativeAccountId, resolveRole } from '@podium/runtime'
import {
  AlarmClock,
  Archive,
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  FolderPlus,
  GitBranch,
  Pin,
  Plus,
  Search,
  Settings as SettingsIcon,
} from 'lucide-react'
import type {
  CSSProperties,
  JSX,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { NEW_AGENTS } from '@/app/NewPanelMenu'
import { useStoreSelector } from '@/app/store'
import { GitStamp } from '@/components/GitStamp'
import { IdSquare } from '@/components/IdSquare'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { IssueContextMenu } from '@/features/issues/IssueContextMenu'
import { issueIdTitle } from '@/features/issues/issue-card'
import { NewIssueDialog } from '@/features/issues/NewIssueDialog'
import { RepoScanFlow } from '@/features/setup/RepoScanFlow'
import {
  branchRollup,
  draftIssueLabel,
  groupUnifiedWorkRows,
  isCoordinatorSession,
  isIssueSnoozed,
  issueAwaitingMerge,
  issueReturnedFromDefer,
  lastUsedMaps,
  type MotionPhase,
  machinesWithRepo,
  panelLabel,
  partitionStaleSessions,
  pickPaneSession,
  type RepoNavView,
  resolveDefaultAgent,
  resolveTargetMachine,
  rowMotionPhase,
  rowMotionTiming,
  rowStatusLine,
  rowUnreadEmphasized,
  rowWaitingCount,
  type SidebarSections,
  sessionsForIssueNav,
  sessionsForWorktree,
  sessionsNeedChildRows,
  sidebarSections,
  spawnTargetForRepo,
  splitPinnedWork,
  type UnifiedIssueRow as UnifiedIssueRowView,
  type UnifiedWorkRow,
  unifiedWorkList,
} from '@/lib/derive'
import { FLOW_SLATE, issueColorHex } from '@/lib/issueColors'
import {
  BrailleSpinner,
  PhaseTimer,
  type RowTransitionItem,
  type RowTransitionTarget,
  usePhaseMorph,
  useRowTransitions,
} from '@/lib/motion'
import type { ContextMenuAnchor } from '@/lib/SessionContextMenu'
import { useFeature } from '@/lib/use-feature'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { SessionNameEditor } from '@/lib/WorkerLabel'
import { planReorderKeys } from './reorder'
import {
  AgentRosterBand,
  GroupedSessionRows,
  PanelRow,
  StaleSection,
  useCollapsed,
} from './sidebar-common'
import { useRowDrag } from './useRowDrag'

/** Icon component for an agent kind (shared with the "+" menu's agent list). */
function agentIconFor(kind: AgentKind) {
  return NEW_AGENTS.find((a) => a.kind === kind)?.Icon
}

/** Compact execution presence that survives a collapsed issue row. The full
 * roster remains below the row; this summary answers "who is here?" without
 * making the operator keep every fleet expanded. */
function IssueFleetSummary({ sessions }: { sessions: SessionMeta[] }): JSX.Element | null {
  if (sessions.length === 0) return null
  const shown = sessions.slice(0, 2)
  const overflow = Math.max(0, sessions.length - shown.length)
  const nativeCount = sessions.reduce(
    (sum, session) => sum + (session.agentState?.nativeSubagentCount ?? 0),
    0,
  )
  const label = [
    `${sessions.length} agent${sessions.length === 1 ? '' : 's'}`,
    nativeCount > 0 ? `${nativeCount} native subagent${nativeCount === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <span
      className="relative ml-0.5 flex flex-none items-center"
      role="img"
      aria-label={label}
      title={label}
      data-testid="issue-fleet-summary"
    >
      {shown.map((session, index) => {
        const AgentIcon = agentIconFor(session.agentKind)
        return (
          <span
            key={session.sessionId}
            data-agent-kind={session.agentKind}
            className={cn(
              'flex size-[17px] items-center justify-center rounded-[5px] border border-[#2c3958] bg-[#111b2d] text-[#d97757]',
              index > 0 && '-ml-1',
            )}
          >
            {AgentIcon ? <AgentIcon size={10} strokeWidth={1.8} aria-hidden="true" /> : '✳'}
          </span>
        )
      })}
      {overflow > 0 && (
        <span className="-ml-1 flex h-[17px] min-w-[17px] items-center justify-center rounded-[5px] border border-[#2c3958] bg-[#111b2d] px-0.5 font-mono text-[8px] text-[#9aa4c0]">
          +{overflow}
        </span>
      )}
      {nativeCount > 0 && (
        <span className="-mt-2 -ml-1 rounded-[4px] border border-[#50392f] bg-[#241915] px-[2px] font-mono text-[7px] leading-[11px] text-[#d97757]">
          ×{nativeCount}
        </span>
      )}
    </span>
  )
}

/** Lineage flash (POD-85): briefly outline another issue's row — provenance as
 *  a gesture when a spin-off is selected, not persistent chrome. DOM-level on
 *  purpose: the origin row is a sibling React branch, and a one-shot class
 *  beats threading transient state through the whole list. */
function flashLineage(issueId: string): void {
  const el = document.querySelector(`[data-issue-row="${CSS.escape(issueId)}"]`)
  if (!(el instanceof HTMLElement)) return
  el.classList.remove('morph-lineage')
  void el.offsetWidth
  el.classList.add('morph-lineage')
  window.setTimeout(() => el.classList.remove('morph-lineage'), 1700)
}

/**
 * The redesigned work sidebar (#41, .design/specs/sidebar.md): the
 * `New <Agent> in <Repo>` spawn row over ONE list of work rows grouped by
 * project (mono section labels), each row carrying its ID square, two-line
 * status anatomy, motion-grammar meta and — when selected — the bridge notch
 * growing toward the engraved column.
 *
 * The pieces are exported separately because the collapsed rail shares their
 * hooks and row behavior.
 */
export interface SidebarDerivation {
  sections: SidebarSections
  allWorktreePaths: string[]
  work: UnifiedWorkRow[]
  now: number
}

export function useSidebarDerivation(): SidebarDerivation {
  const { repos, sessions, pins, issues } = useStoreSelector(
    (s) => ({ repos: s.repos, sessions: s.sessions, pins: s.pins, issues: s.issues }),
    shallowEqual,
  )
  const now = useNow(60_000)
  return useMemo(() => {
    const sections = sidebarSections(repos, sessions, pins, now, issues)
    const allWorktreePaths = [...sections.pinnedRepos, ...sections.repos].flatMap((repo) =>
      repo.worktrees.map((worktree) => worktree.path),
    )
    return {
      sections,
      allWorktreePaths,
      work: unifiedWorkList(sections, issues, sessions, allWorktreePaths, now),
      now,
    }
  }, [repos, sessions, pins, issues, now])
}

export function SidebarUnified(): JSX.Element {
  const derivation = useSidebarDerivation()
  return (
    <>
      <NewWorkRow sections={derivation.sections} />
      {/* Divider under the spawn row — the handoff's 4px margins plus the
          column's 3px flex gap on each side land at 11px above / 9px below. */}
      <div
        data-testid="sidebar-divider"
        className="mx-2.5 mt-[11px] mb-[9px] h-px flex-none bg-[#25252f]"
        aria-hidden="true"
      />
      {/* The scroll container leaves 5px of horizontal head-room past the aside
          edge (negative margin + matching padding) so the selected row's bridge
          notch can paint OVER the aside border into the engraved column —
          overflow clips at the padding box, so the notch survives (#41). Rows
          sit at the column's 8px side inset (13 − 5); the column's 3px rhythm
          continues between project groups via the flex gap. */}
      <div
        data-testid="work-scroll"
        className="scroll-none flex min-h-0 flex-1 flex-col gap-[3px] overflow-y-auto pb-2.5 pl-2"
        style={{ marginRight: -5, paddingRight: 13 }}
      >
        <WorkSections derivation={derivation} />
      </div>
      {/* Footer: 8px top / 10px sides, 4px own bottom + the column's 6px. */}
      <AppToolsRow className="flex-none border-t border-[#25252f] px-2.5 pt-2 pb-2.5" />
    </>
  )
}

/**
 * The one top row: `New <Agent> in <Repo>` wearing the handoff's compact
 * bordered look (main surface spawns; the chevron segment opens the
 * agent→repo menu) + the `New issue…` entry inside that menu.
 */
/**
 * Default spawn target + spawn/persist actions shared by the wide `New <Agent>
 * in <Repo>` row and the rail's compact new-Claude button (#41).
 */
export function useDefaultSpawn(sectionsOverride?: SidebarSections) {
  const {
    repos,
    sessions,
    trpc,
    setSelectedWorktree,
    setSelectedIssueId,
    setPane,
    setView,
    machines,
    spawnDraftAgent,
    pins,
    issues,
  } = useStoreSelector(
    (s) => ({
      repos: s.repos,
      sessions: s.sessions,
      trpc: s.trpc,
      setSelectedWorktree: s.setSelectedWorktree,
      setSelectedIssueId: s.setSelectedIssueId,
      setPane: s.setPane,
      setView: s.setView,
      machines: s.machines,
      spawnDraftAgent: s.spawnDraftAgent,
      pins: s.pins,
      issues: s.issues,
    }),
    shallowEqual,
  )
  const now = useNow(60_000)
  // The user's persisted default agent ('auto' resolves against session history).
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

  const sections = sectionsOverride ?? sidebarSections(repos, sessions, pins, now, issues)
  const { byRepo } = lastUsedMaps(sections, sessions)
  const repoNavs: RepoNavView[] = [...sections.pinnedRepos, ...sections.repos]
  // <Repo> on the button = the repo of the most recent session activity.
  const defaultRepo = repoNavs.reduce<RepoNavView | undefined>(
    (best, r) =>
      best === undefined || (byRepo.get(r.path) ?? 0) > (byRepo.get(best.path) ?? 0) ? r : best,
    undefined,
  )
  // The spawn target is the repo's primary checkout on the default machine
  // (MRU for this repo, then first online machine with the repo).
  const defaultMachine = defaultRepo
    ? resolveTargetMachine(defaultRepo, sessions, machines)
    : undefined
  const defaultTarget = defaultRepo ? spawnTargetForRepo(defaultRepo, defaultMachine) : undefined
  const defaultAgent = resolveDefaultAgent(agentSetting, sessions)
  // Menu repos read most-recently-used first (name tiebreak) — same order the
  // default <Repo> pick uses, so the top menu entry IS the default.
  const menuRepos = [...repoNavs].sort(
    (a, b) =>
      (byRepo.get(b.path) ?? 0) - (byRepo.get(a.path) ?? 0) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )

  /** Spawn `agentKind` in `repo`'s primary worktree inside a fresh draft issue.
   *  Optimistic (#119): the store paints the 'starting' row + draft vessel
   *  instantly, so we navigate synchronously with the client-minted ids — no
   *  waiting on the create round-trip or its broadcast. */
  function spawn(agentKind: AgentKind, repo: RepoNavView, machineId?: string): void {
    const targetMachine = machineId ?? resolveTargetMachine(repo, sessions, machines)
    const { worktree: wt } = spawnTargetForRepo(repo, targetMachine)
    const { sessionId, issueId } = spawnDraftAgent({ target: wt, agentKind })
    setSelectedIssueId(issueId)
    setSelectedWorktree(wt.path)
    setPane('A', sessionId)
    setView('workspace')
  }

  /** Persist a menu-picked agent as the new default (roles.coding.accountId).
   *  'shell' isn't a valid session default — a shell pick spawns but doesn't
   *  change the sticky default. */
  async function persistDefaultAgent(kind: AgentKind): Promise<void> {
    if (kind === 'shell') return
    try {
      const current = await trpc.settings.get.query()
      const updated = await trpc.settings.set.mutate({
        ...current,
        roles: {
          ...current.roles,
          coding: { ...current.roles.coding, accountId: nativeAccountId(kind) },
        },
      })
      setAgentSetting(resolveRole(updated, 'coding').harness)
    } catch {
      setAgentSetting(kind) // optimistic — best-effort persistence
    }
  }

  return {
    defaultAgent,
    defaultRepo,
    defaultTarget,
    menuRepos,
    machines,
    spawn,
    persistDefaultAgent,
  }
}

export function NewWorkRow({ sections }: { sections?: SidebarSections } = {}): JSX.Element {
  const {
    defaultAgent,
    defaultRepo,
    defaultTarget,
    menuRepos,
    machines,
    spawn,
    persistDefaultAgent,
  } = useDefaultSpawn(sections)
  const [newIssueOpen, setNewIssueOpen] = useState(false)
  // Anchor for the agent/repo menu: the WHOLE bordered button container, so the
  // dropdown opens directly under it, left-aligned, at the button's exact width
  // (the popup's w-(--anchor-width) tracks the Positioner anchor).
  const newAgentAnchorRef = useRef<HTMLDivElement | null>(null)

  return (
    <div className="mx-2 mt-2.5 flex items-center gap-2">
      <div
        ref={newAgentAnchorRef}
        data-testid="new-agent-button"
        className="relative min-w-0 flex-1"
      >
        {/* One bordered rounded-lg surface with a leading Claude-clay agent icon;
            the chevron is a borderless hitbox floating inside the same outline. */}
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-[#3a3a46] bg-[#25252f] px-[10px] py-2 pr-[32px] text-[12px] leading-[normal] font-medium text-[#eaeaf0] transition-colors hover:border-[#4a4a56] hover:bg-[#2b2b36] disabled:opacity-50"
          disabled={!defaultRepo}
          title={
            defaultTarget
              ? `Start a new ${panelLabel(defaultAgent)} agent in ${defaultTarget.repoName}`
              : 'No repos yet'
          }
          onClick={() => defaultRepo && void spawn(defaultAgent, defaultRepo)}
        >
          {(() => {
            const AgentIcon = agentIconFor(defaultAgent)
            return AgentIcon ? (
              <AgentIcon
                size={14}
                aria-hidden="true"
                className={cn('flex-none', defaultAgent === 'claude-code' && 'text-claude')}
              />
            ) : null
          })()}
          <span className="min-w-0 truncate">
            New {panelLabel(defaultAgent)} in {defaultTarget?.repoName ?? '…'}
          </span>
        </button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="absolute top-1/2 right-[9px] flex size-6 -translate-y-1/2 items-center justify-center rounded text-[#7a7a86] hover:text-foreground"
                aria-label="Choose agent and repo"
              >
                <ChevronDown size={13} aria-hidden="true" />
              </button>
            }
          />
          <DropdownMenuContent align="start" sideOffset={4} anchor={newAgentAnchorRef}>
            {NEW_AGENTS.map(({ kind, label, Icon }) => (
              <DropdownMenuSub key={kind}>
                <DropdownMenuSubTrigger
                  className="flex items-center gap-1.5"
                  onClick={() => {
                    if (!defaultRepo) return
                    void persistDefaultAgent(kind)
                    void spawn(kind, defaultRepo)
                  }}
                >
                  <Icon size={14} aria-hidden="true" className="text-muted-foreground" />
                  {label}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {menuRepos.length === 0 && <DropdownMenuItem disabled>No repos</DropdownMenuItem>}
                  {menuRepos.map((repo) => {
                    const repoMachines = machinesWithRepo(repo, machines)
                    if (repoMachines.length <= 1) {
                      return (
                        <DropdownMenuItem
                          key={repo.path}
                          onClick={() => {
                            void persistDefaultAgent(kind)
                            void spawn(kind, repo)
                          }}
                        >
                          {repo.name}
                        </DropdownMenuItem>
                      )
                    }
                    return (
                      <DropdownMenuSub key={repo.path}>
                        <DropdownMenuSubTrigger
                          onClick={() => {
                            void persistDefaultAgent(kind)
                            void spawn(kind, repo)
                          }}
                        >
                          {repo.name}
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          {repoMachines.map((machine) => (
                            <DropdownMenuItem
                              key={machine.id}
                              disabled={!machine.online}
                              onClick={() => {
                                void persistDefaultAgent(kind)
                                void spawn(kind, repo, machine.id)
                              }}
                            >
                              <Circle
                                size={6}
                                className={
                                  machine.online
                                    ? 'fill-success text-success'
                                    : 'text-muted-foreground/40'
                                }
                                aria-hidden="true"
                              />
                              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                                {machine.name}
                              </span>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    )
                  })}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
            {/* New issue lives in this menu now — the top row is a single control. */}
            <DropdownMenuItem onClick={() => setNewIssueOpen(true)}>
              <Plus size={14} aria-hidden="true" className="text-muted-foreground" />
              New task…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {newIssueOpen && <NewIssueDialog onClose={() => setNewIssueOpen(false)} />}
    </div>
  )
}

/** App-level tools: add repo, analytics, settings, search (the cmd-k palette) —
 *  four 28px icon buttons spread across the footer (handoff §2.1). */
export function AppToolsRow({ className }: { className?: string }): JSX.Element {
  const { view, setView, setPaletteOpen } = useStoreSelector(
    (s) => ({ view: s.view, setView: s.setView, setPaletteOpen: s.setPaletteOpen }),
    shallowEqual,
  )
  const [repoScanOpen, setRepoScanOpen] = useState(false)
  const commandPaletteEnabled = useFeature('command-palette')
  const btn = (active = false) =>
    cn(
      'flex size-7 items-center justify-center rounded-md text-[#9a9aa8] transition-colors hover:bg-[#20202a] hover:text-[#f3f3f8]',
      active && 'bg-[#20202a] text-[#f3f3f8]',
    )
  return (
    <div className={cn('flex items-center justify-around', className)}>
      <button
        type="button"
        className={btn()}
        title="Add repo"
        aria-label="Add repo"
        onClick={() => setRepoScanOpen(true)}
      >
        <FolderPlus size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={btn(view === 'usage')}
        aria-pressed={view === 'usage'}
        title="Usage & analytics"
        aria-label="Usage & analytics"
        onClick={() => setView('usage')}
      >
        <BarChart3 size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={btn(view === 'settings')}
        aria-pressed={view === 'settings'}
        title="Settings"
        aria-label="Settings"
        onClick={() => setView('settings')}
      >
        <SettingsIcon size={15} aria-hidden="true" />
      </button>
      {commandPaletteEnabled && (
        <button
          type="button"
          className={btn()}
          title="Search (⌘K)"
          aria-label="Search"
          onClick={() => setPaletteOpen(true)}
        >
          <Search size={15} aria-hidden="true" />
        </button>
      )}
      {repoScanOpen && (
        <RepoScanFlow
          onClose={() => setRepoScanOpen(false)}
          onDone={() => setRepoScanOpen(false)}
        />
      )}
    </div>
  )
}

/** Project section label: mono 8.5px uppercase over a trailing hairline (§2.2).
 *  Grouping is always on — no toggle, no chevron, no collapse. */
function ProjectGroupLabel({ label, first }: { label: string; first: boolean }): JSX.Element {
  return (
    <div
      data-testid="project-group-label"
      className={cn(
        'flex items-center gap-1.5 px-1 pb-0.5 font-mono text-[8.5px] leading-[normal] tracking-[.12em] uppercase text-[#7a7a86]',
        first ? 'pt-1' : 'pt-2',
      )}
    >
      <span className="truncate">{label}</span>
      <span className="h-px min-w-4 flex-1 bg-[#25252f]" aria-hidden="true" />
    </div>
  )
}

/** PINNED section label (POD-166, R3): the one section above all project
 *  groups — same mono hairline voice, led by an attention-toned pin. */
function PinnedSectionLabel(): JSX.Element {
  return (
    <div
      data-testid="pinned-section-label"
      className="flex items-center gap-1.5 px-1 pt-1 pb-0.5 font-mono text-[8.5px] leading-[normal] tracking-[.12em] uppercase text-[#7a7a86]"
    >
      <Pin size={9} className="flex-none text-attention" aria-hidden="true" />
      <span>Pinned</span>
      <span className="h-px min-w-4 flex-1 bg-[#25252f]" aria-hidden="true" />
    </div>
  )
}

type WorkPlacement =
  | {
      lane: 'pinned' | 'open'
      groupKey: string
      groupLabel: string
      row: UnifiedWorkRow
    }
  | {
      lane: 'closed'
      groupKey: string
      groupLabel: string
      row: UnifiedIssueRowView
    }

type TransitionWorkRow = RowTransitionItem<WorkPlacement>

/** Project-local disclosure for settled top-level closures (POD-183). Rows are
 * derived newest-closed-first; Archive is the explicit removal gesture. */
function ClosedIssueFold<T>({
  groupKey,
  rows,
  renderRow,
  issueForRow,
  onArchive,
}: {
  groupKey: string
  rows: T[]
  renderRow: (row: T) => JSX.Element
  issueForRow: (row: T) => UnifiedIssueRowView
  onArchive: (id: string) => void
}): JSX.Element {
  const [collapsed, toggle] = useCollapsed(`podium:sidebar:closed-fold:${groupKey}`, true)
  const contentId = useId()
  return (
    <div className="min-w-0" data-testid="closed-issue-fold">
      <button
        type="button"
        className="group/fold flex min-h-[31px] w-full items-center gap-1.5 rounded-[5px] px-2 py-0.5 text-left font-mono text-[10px] font-medium tracking-[.035em] text-[#525c78] hover:text-[#9a9aa8] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#364a78] focus-visible:outline-offset-[-2px]"
        aria-expanded={!collapsed}
        aria-controls={contentId}
        onClick={toggle}
        data-testid="closed-fold-toggle"
      >
        <ChevronRight
          size={11}
          className={cn('flex-none transition-transform duration-150', !collapsed && 'rotate-90')}
          aria-hidden="true"
        />
        <span>Closed · {rows.length}</span>
        <span className="h-px min-w-4 flex-1 bg-[#1e2a4c]" aria-hidden="true" />
      </button>
      {!collapsed && (
        <div id={contentId} className="min-w-0" data-testid="closed-fold-rows">
          {rows.map((row) => {
            const issueRow = issueForRow(row)
            return (
              <div
                key={issueRow.issue.id}
                className="group/closed relative min-w-0"
                data-testid="closed-fold-row"
              >
                {renderRow(row)}
                <button
                  type="button"
                  className="absolute top-1.5 right-1 z-20 flex size-6 items-center justify-center rounded-[5px] border border-[#30303b] bg-[#1a1a22] text-[#777785] opacity-0 shadow-sm transition-[color,opacity,background-color] group-hover/closed:opacity-100 group-focus-within/closed:opacity-100 hover:bg-[#24242e] hover:text-[#d7d7e0] focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#526b9d]"
                  aria-label={`Archive ${issueDisplayRef(issueRow.issue)}`}
                  title="Archive — remove from sidebar"
                  data-testid="closed-issue-archive"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onArchive(issueRow.issue.id)
                  }}
                >
                  <Archive size={12} aria-hidden="true" />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * The work list: ONE list of issue/worktree rows, always grouped by project
 * (repo), banded urgency order inside each group. The old WORKING / PINNED
 * sections and the group toggle are gone (#41) — state is carried per-row by
 * the square language, the amber pill and the motion-grammar meta.
 * The caller owns the scroll container.
 */
/**
 * The unified work rows plus the selection actions on them — shared by the
 * wide sidebar (WorkSections) and the collapsed rail (SidebarRail, #41), so
 * both surfaces select/open work with identical semantics.
 */
export function useUnifiedWork(derivationOverride?: SidebarDerivation) {
  const {
    repos,
    sessions,
    pins,
    issues,
    trpc,
    selectedWorktree,
    setSelectedWorktree,
    selectedIssueId,
    setSelectedIssueId,
    setOpenIssueId,
    paneA,
    setPane,
    fileTabs,
    setView,
    markIssueRead,
    markSessionRead,
  } = useStoreSelector(
    (s) => ({
      repos: s.repos,
      sessions: s.sessions,
      pins: s.pins,
      issues: s.issues,
      trpc: s.trpc,
      selectedWorktree: s.selectedWorktree,
      setSelectedWorktree: s.setSelectedWorktree,
      selectedIssueId: s.selectedIssueId,
      setSelectedIssueId: s.setSelectedIssueId,
      setOpenIssueId: s.setOpenIssueId,
      paneA: s.paneA,
      setPane: s.setPane,
      fileTabs: s.fileTabs,
      setView: s.setView,
      markIssueRead: s.markIssueRead,
      markSessionRead: s.markSessionRead,
    }),
    shallowEqual,
  )
  const fallbackNow = useNow(60_000)
  const now = derivationOverride?.now ?? fallbackNow
  const sections =
    derivationOverride?.sections ?? sidebarSections(repos, sessions, pins, now, issues)
  const repoNavs: RepoNavView[] = [...sections.pinnedRepos, ...sections.repos]
  const allWorktreePaths =
    derivationOverride?.allWorktreePaths ?? repoNavs.flatMap((r) => r.worktrees.map((w) => w.path))
  const work =
    derivationOverride?.work ?? unifiedWorkList(sections, issues, sessions, allWorktreePaths, now)

  // Switch-latency trace [POD-701]: a gesture that changes the focused SESSION
  // starts a trace at t0. Skipped for no-op switches (target already in pane A)
  // and for file-tab targets (`file:…` — no session to trace).
  const traceSwitchTo = (target: string | null, issueId: string | null) => {
    if (target && target !== paneA && !target.startsWith('file:')) {
      beginSwitch({ sessionId: target, issueId })
    }
  }
  const selectIssue = (issue: IssueWire, paneSession?: string) => {
    setSelectedIssueId(issue.id)
    // Opening an issue marks IT read (email-style, #126): clear the row's unread
    // emphasis optimistically. Its member sessions keep their own unread until
    // each is opened. No-op when already read.
    void markIssueRead(issue.id)
    // A lapsed defer is transient like the session snooze: OPENING an "Unsnoozed"
    // issue clears the stale defer so the tag doesn't linger (email-read semantics).
    // This is the CLEAR path — deliberately defer(null), which nulls deferUntil so
    // `issueReturnedFromDefer` goes false. (It's distinct from the menu's "Unsnooze",
    // issues.undefer, which BACKDATES deferUntil to float the row to the top of WORK
    // WITH the tag — #133.) A still-snoozed issue is left alone.
    if (issueReturnedFromDefer(issue, now)) {
      void trpc.issues.defer.mutate({ id: issue.id, until: null }).catch(() => {})
    }
    if (issue.worktreePath) setSelectedWorktree(issue.worktreePath)
    // Open a pane too (#108): keep the current one if it already belongs to this
    // issue (session or file tab), else the issue's most recently active session.
    const members = sessionsForIssueNav(issue, sessions, allWorktreePaths, {
      includeShells: true,
    })
    const rowFileIds = issue.worktreePath
      ? fileTabs.filter((f) => f.worktreePath === issue.worktreePath).map((f) => f.id)
      : []
    // `paneSession` (a row's specific member, from selectPanelForIssue) wins over
    // the keep-or-most-recent pick, so the trace targets the session that really
    // opens and the pane is only set once.
    const target = paneSession ?? pickPaneSession(members, paneA, rowFileIds)
    traceSwitchTo(target, issue.id)
    setPane('A', target)
    setView('workspace')
  }
  const selectPanelForIssue = (issue: IssueWire, sessionId: string) => {
    selectIssue(issue, sessionId)
    // Opening a specific member session marks THAT session read too (#126).
    void markSessionRead(sessionId)
  }
  const selectWorktree = (path: string) => {
    setSelectedIssueId(null)
    setSelectedWorktree(path)
    // Same pane-opening rule as selectIssue, keyed by the worktree's sessions.
    const members = sessionsForWorktree(sessions, path, allWorktreePaths)
    const rowFileIds = fileTabs.filter((f) => f.worktreePath === path).map((f) => f.id)
    const opened = pickPaneSession(members, paneA, rowFileIds)
    traceSwitchTo(opened, null)
    setPane('A', opened)
    // A worktree has no unread flag of its own — opening it opens one session, so
    // mark THAT session read (#126). Other unread sessions keep the row emphasized.
    if (opened && members.some((s) => s.sessionId === opened)) void markSessionRead(opened)
    setView('workspace')
  }
  const selectPanel = (worktreePath: string, sessionId: string) => {
    traceSwitchTo(sessionId, null)
    setSelectedIssueId(null)
    setSelectedWorktree(worktreePath)
    setPane('A', sessionId)
    // Opening a session marks it read (#126).
    void markSessionRead(sessionId)
    setView('workspace')
  }
  // Open the issue PAGE (the right-click "Open" action), leaving the workspace.
  const openIssuePage = (id: string) => {
    setOpenIssueId(id)
    setView('issues')
  }

  // Concrete mutation callbacks rather than the raw trpc client, so the hook's
  // inferred return type stays portable across packages.
  const renameIssue = (id: string, title: string): void => {
    void trpc.issues.update.mutate({ id, patch: { title } }).catch(() => {})
  }
  const setIssueColor = (id: string, color: IssueColorSlot | null): Promise<unknown> =>
    trpc.issues.update.mutate({ id, patch: { color } })
  const archiveIssue = (id: string): void => {
    void trpc.issues.archive.mutate({ id }).catch(() => {})
  }
  // Manual-sort persistence (POD-168): one patch per row whose key changes
  // (fast path = exactly the dragged row; legacy backfill = the whole scope).
  const applySortPatches = (
    patches: Array<{ id: string; sortKey: string; pinned?: boolean }>,
  ): Promise<unknown> =>
    Promise.all(
      patches.map(({ id, sortKey, pinned }) =>
        trpc.issues.update.mutate({
          id,
          patch: { sortKey, ...(pinned === undefined ? {} : { pinned }) },
        }),
      ),
    )

  return {
    work,
    sessions,
    issues,
    allWorktreePaths,
    now,
    paneA,
    selectedIssueId,
    selectedWorktree,
    selectIssue,
    selectPanelForIssue,
    selectWorktree,
    selectPanel,
    openIssuePage,
    renameIssue,
    setIssueColor,
    archiveIssue,
    applySortPatches,
  }
}

export function WorkSections({ derivation }: { derivation?: SidebarDerivation } = {}): JSX.Element {
  const {
    work,
    sessions,
    issues,
    allWorktreePaths,
    now,
    paneA,
    selectedIssueId,
    selectedWorktree,
    selectIssue,
    selectPanelForIssue,
    selectWorktree,
    selectPanel,
    openIssuePage,
    renameIssue,
    setIssueColor,
    archiveIssue,
    applySortPatches,
  } = useUnifiedWork(derivation)
  const [selectedClosedPlacement, setSelectedClosedPlacement] = useState<{
    issueId: string
    folded: boolean
  } | null>(null)
  useEffect(() => {
    setSelectedClosedPlacement((placement) =>
      placement && placement.issueId !== selectedIssueId ? null : placement,
    )
  }, [selectedIssueId])

  const { pinned, rest } = useMemo(() => splitPinnedWork(work), [work])
  const targetGroups = useMemo(
    () =>
      groupUnifiedWorkRows(
        rest,
        selectedIssueId,
        selectedClosedPlacement?.issueId === selectedIssueId && selectedClosedPlacement.folded,
      ),
    [rest, selectedClosedPlacement, selectedIssueId],
  )
  const transitionTargets = useMemo<RowTransitionTarget<WorkPlacement>[]>(
    () => [
      ...pinned.map((row) => ({
        key: row.kind === 'issue' ? `issue:${row.issue.id}` : `wt:${row.worktree.path}`,
        placement: 'active',
        value: {
          lane: 'pinned' as const,
          groupKey: 'pinned',
          groupLabel: 'Pinned',
          row,
        },
      })),
      ...targetGroups.flatMap((group) => [
        ...group.rows.map((row) => ({
          key: row.kind === 'issue' ? `issue:${row.issue.id}` : `wt:${row.worktree.path}`,
          placement: 'active',
          value: {
            lane: 'open' as const,
            groupKey: group.key,
            groupLabel: group.label,
            row,
          },
        })),
        ...group.closedRows.map((row) => ({
          key: `issue:${row.issue.id}`,
          placement: `closed:${group.key}`,
          value: {
            lane: 'closed' as const,
            groupKey: group.key,
            groupLabel: group.label,
            row,
          },
        })),
      ]),
    ],
    [pinned, targetGroups],
  )
  const { items: transitionRows, settle } = useRowTransitions(transitionTargets)

  // Grip-drag manual sort (POD-168): drops persist fractional sortKeys through
  // issues.update; crossing the PINNED boundary toggles `pinned`. The preview
  // holds until the store echoes the new order (settleDrag in the effect below),
  // and reordering never touches row KEYS — so useArrivals stays silent (no
  // arrival one-shot on a drag, only on genuinely new rows).
  const issueById = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues])
  const { startDrag, settleDrag } = useRowDrag({
    allowedTargets: (sourceScope, movedId) => {
      if (sourceScope === 'pinned') {
        const moved = issueById.get(movedId)
        return moved ? [`group:${moved.repoId ?? moved.repoPath}`] : []
      }
      if (sourceScope.startsWith('group:')) return ['pinned']
      return [] // children scopes: strictly within the parent
    },
    onDrop: ({ sourceScope, targetScope, movedId, order }) => {
      const patches = planReorderKeys(order, movedId, (id) => issueById.get(id)?.sortKey)
      const crossedPinned = sourceScope !== targetScope
      void applySortPatches(
        patches.map((p) => ({
          ...p,
          ...(crossedPinned && p.id === movedId ? { pinned: targetScope === 'pinned' } : {}),
        })),
      ).catch(() => settleDrag())
    },
  })
  const onGripDown = (e: ReactPointerEvent, issueId: string) => startDrag(e, issueId)
  // The mutation round-trips over the ws; when the derived order lands, drop
  // the held drag preview (transforms) in the same commit.
  useEffect(() => {
    // `work` is the trigger: a fresh derived order means the reorder landed.
    void work
    settleDrag()
  }, [work, settleDrag])

  const renderWorkRow = (item: TransitionWorkRow) => {
    const { row, lane } = item.value
    const folded = lane === 'closed'
    const arriving = item.phase === 'entering'
    const inner =
      row.kind === 'issue' ? (
        <UnifiedIssueRow
          row={row}
          allWorktreePaths={allWorktreePaths}
          sessions={sessions}
          issues={issues}
          selectedIssueId={selectedIssueId}
          paneA={paneA}
          now={now}
          onSelectIssue={(issue) => {
            setSelectedClosedPlacement({ issueId: issue.id, folded })
            selectIssue(issue)
          }}
          onSelectPanelForIssue={(issue, sessionId) => {
            setSelectedClosedPlacement({ issueId: issue.id, folded })
            selectPanelForIssue(issue, sessionId)
          }}
          onOpenIssue={openIssuePage}
          onRenameIssue={renameIssue}
          onColorChangeIssue={setIssueColor}
          onGripDown={onGripDown}
        />
      ) : (
        <UnifiedWorktreeRow
          row={row}
          issues={issues}
          active={selectedIssueId === null && selectedWorktree === row.worktree.path}
          paneA={paneA}
          now={now}
          onSelect={() => selectWorktree(row.worktree.path)}
          onSelectPanel={(sid) => selectPanel(row.worktree.path, sid)}
        />
      )
    return (
      <div
        key={`${item.key}:${item.placement}`}
        {...(row.kind === 'issue' ? { 'data-drag-key': row.issue.id } : {})}
        className={cn(
          'min-w-0',
          arriving && 'row-arrive',
          item.phase === 'exiting' && 'row-depart',
          folded &&
            'opacity-50 transition-opacity duration-150 hover:opacity-80 focus-within:opacity-80',
        )}
        style={
          arriving && row.kind === 'issue'
            ? ({
                '--arrive-tint': issueColorHex(row.issue.color),
              } as CSSProperties)
            : undefined
        }
        onAnimationEnd={
          arriving
            ? (e) => {
                // The wash is the longest of the three one-shots — its end (which
                // bubbles up from the row) means the arrival is fully over.
                if (e.animationName === 'podium-arrive-wash') settle(item.key, item.placement)
              }
            : undefined
        }
        data-transition-phase={item.phase}
      >
        {inner}
      </div>
    )
  }

  const renderedPinned = transitionRows.filter((item) => item.value.lane === 'pinned')
  const renderedGroupKeys = targetGroups.map((group) => group.key)
  for (const item of transitionRows) {
    if (item.value.lane !== 'pinned' && !renderedGroupKeys.includes(item.value.groupKey))
      renderedGroupKeys.push(item.value.groupKey)
  }
  const renderedGroups = renderedGroupKeys.map((groupKey) => {
    const target = targetGroups.find((group) => group.key === groupKey)
    const fallback = transitionRows.find((item) => item.value.groupKey === groupKey)
    return {
      key: groupKey,
      label: target?.label ?? fallback?.value.groupLabel ?? groupKey,
      rows: transitionRows.filter(
        (item) => item.value.groupKey === groupKey && item.value.lane === 'open',
      ),
      closedRows: transitionRows.filter(
        (item) => item.value.groupKey === groupKey && item.value.lane === 'closed',
      ),
    }
  })

  if (transitionRows.length === 0) {
    return (
      <div className="p-3 text-xs text-muted-foreground/70">
        Nothing yet — start an agent or create an issue above.
      </div>
    )
  }
  // Pinned issues MOVE above all project groups (POD-166, R3) — they leave
  // their group entirely; unpinning returns them to its banded order.
  return (
    <>
      {renderedPinned.length > 0 && (
        <div
          className="flex min-w-0 flex-col gap-[3px]"
          data-testid="pinned-section"
          data-drag-scope="pinned"
        >
          <PinnedSectionLabel />
          {renderedPinned.map(renderWorkRow)}
        </div>
      )}
      {renderedGroups.map((group, index) => (
        <div
          key={group.key}
          className="flex min-w-0 flex-col gap-[3px]"
          data-testid="project-group"
          data-drag-scope={`group:${group.key}`}
        >
          <ProjectGroupLabel
            label={group.label}
            first={index === 0 && renderedPinned.length === 0}
          />
          {group.rows.map(renderWorkRow)}
          {group.closedRows.length > 0 && (
            <ClosedIssueFold
              groupKey={group.key}
              rows={group.closedRows}
              renderRow={renderWorkRow}
              issueForRow={(item) => item.value.row as UnifiedIssueRowView}
              onArchive={archiveIssue}
            />
          )}
        </div>
      ))}
    </>
  )
}

/** Line-1/line-2 text tints for one row (§2.4): everything colour-flows from
 *  the issue colour; uncoloured rows read the neutral greys (slate when
 *  selected — the no-colour flow accent, never a pickable colour). */
function rowTints(hex: string | undefined, phase: MotionPhase, active: boolean) {
  return {
    title: active
      ? hex
        ? `color-mix(in srgb, ${hex} 10%, #f7f7fc)`
        : '#f2f5fa'
      : hex
        ? `color-mix(in srgb, ${hex} 25%, #d7d7e0)`
        : phase === 'queued'
          ? '#9a9aa8'
          : '#d7d7e0',
    status: hex ? `color-mix(in srgb, ${hex} 55%, #9a9aa8)` : active ? '#aab6c8' : '#6c6c78',
  }
}

/**
 * The shared two-line WORK-row skeleton (§2.4/§2.5):
 * [ID square][title + amber pill / status line + motion meta][bridge notch].
 * Issue and worktree rows both render through it — they differ only in the
 * leading square and their extras. Queued rows dim whole (.65); the selected
 * row wears the colour-mixed background, border and the notch that crosses the
 * aside border toward the engraved column.
 */
function WorkRowShell({
  square,
  label,
  statusLine,
  hex,
  phase,
  waitingCount,
  timeMeta,
  active,
  unread = false,
  expandable,
  collapsed,
  onToggle,
  onSelect,
  onContextMenu,
  onDoubleClick,
  editor,
  extras,
  titleHint,
  children,
  testId,
  deemphasized = false,
  domMark,
  statusExtra,
  gitStamp,
  onGripDown,
  band,
  hasTreeChildren,
  childDragScope,
  childrenTestId,
}: {
  /** The leading 26px identity square (owns its own click). */
  square: ReactNode
  label: string
  /** Line 2's status phrase (`rowStatusLine`), grouped with phase icon + timer. */
  statusLine: ReactNode
  /** The issue colour hex, undefined for the neutral/slate flow. */
  hex: string | undefined
  phase: MotionPhase
  /** Amber line-1 pill count (0 = no pill). */
  waitingCount: number
  /** Line 2's lifecycle meta (the PhaseTimer). */
  timeMeta?: ReactNode
  active: boolean
  /** Email-style unread emphasis (#126): the label reads bold until opened. */
  unread?: boolean
  expandable: boolean
  collapsed: boolean
  onToggle: () => void
  onSelect: () => void
  /** Right-click the row's select button (opens the issue context menu). */
  onContextMenu?: (e: ReactMouseEvent) => void
  /** Double-click the row's label (issue rename, #170). */
  onDoubleClick?: () => void
  /** When present, replaces the two-line block with an inline-rename input. */
  editor?: ReactNode
  /** Line-1 chips after the title (pin / snooze / epic). */
  extras?: ReactNode
  /** Native hover tooltip on the row (issue ids, #21). */
  titleHint?: string
  children?: ReactNode
  testId: string
  /** Internal decomposition stays visible but subordinate to tracked work. */
  deemphasized?: boolean
  /** Issue id stamped as data-issue-row so lineage flashes can find the row. */
  domMark?: string
  /** Line 2's trailing slot after the timer (the spin-off ⤷ tick, POD-85). */
  statusExtra?: ReactNode
  /** Line 2's git stamp [POD-98]: dot + commit counters after the status phrase. */
  gitStamp?: ReactNode
  /** Manual-sort grip (POD-168): when set, a ⠿ handle fades in on the row's
   *  left edge on hover and pointerdown starts a drag. */
  onGripDown?: (e: ReactPointerEvent) => void
  /** Agent roster band (POD-170, L2): rendered adjacent to the row, outside
   * the subtask tree, and folded with the row's other secondary detail. */
  band?: ReactNode
  /** True when the detail block contains issue-tree/roll-up content. */
  hasTreeChildren: boolean
  /** Drag scope and test marker belong on the actual tree container so each
   * child can be a direct descendant and receive a correctly aligned stub. */
  childDragScope?: string
  childrenTestId?: string
}): JSX.Element {
  // One-shot transition morphs (§2.6): fire only on a REAL phase change under a
  // mounted row — queued→working ignites the square, →waiting flashes the row.
  const morph = usePhaseMorph(phase)
  const accent = hex ?? FLOW_SLATE
  const tints = rowTints(hex, phase, active)
  const rowStyle: CSSProperties = active
    ? {
        background: `color-mix(in srgb, ${accent} ${hex ? 28 : 20}%, #16161c)`,
        // Inset ring, not a border: selection must not change the row's height
        // (POD-81) — the box stays identical to a plain row's.
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${accent} ${hex ? 80 : 70}%, transparent)`,
      }
    : hex
      ? // Var-driven so the hover class can override it — an inline `background`
        // would always beat `hover:` (POD-166: tint-aware hover, +5% mix).
        ({
          '--row-bg': `color-mix(in srgb, ${hex} 12%, #16161c)`,
          '--row-hover-bg': `color-mix(in srgb, ${hex} 17%, #16161c)`,
        } as CSSProperties)
      : {}
  return (
    <div className="min-w-0" data-testid={testId}>
      <div
        className={cn(
          'phase-surface group/row relative flex min-w-0 items-center gap-2 rounded-[7px] py-[5px] pr-2 pl-3.5',
          !active && !hex && 'hover:bg-[#20202a]',
          !active && hex && 'bg-[var(--row-bg)] hover:bg-[var(--row-hover-bg)]',
          phase === 'queued' && !active && 'opacity-65',
          phase === 'done' && !active && !unread && 'opacity-70',
          morph === 'waiting' && 'morph-row-flash',
          deemphasized && !active && 'scale-[0.98] opacity-70',
        )}
        style={rowStyle}
        data-phase={phase}
        data-selected={active ? 'true' : 'false'}
        {...(domMark ? { 'data-issue-row': domMark } : {})}
      >
        {onGripDown && (
          // Manual-sort grip (POD-168, §4): 10px zone on the row's left edge,
          // visible only on hover — order is the user's, nothing else moves it.
          <span
            className="absolute inset-y-0 left-0.5 z-[1] flex w-2.5 cursor-grab select-none items-center justify-center text-[9px] leading-none text-transparent transition-colors duration-150 group-hover/row:text-muted-foreground/70"
            style={{ touchAction: 'none' }}
            data-testid="row-grip"
            aria-hidden="true"
            onPointerDown={onGripDown}
          >
            ⠿
          </span>
        )}
        <span className={cn('flex flex-none', morph === 'working' && 'morph-ignite')}>
          {square}
        </span>
        {expandable && (
          <button
            type="button"
            className="-ml-1.5 flex w-3.5 flex-none cursor-pointer items-center justify-center self-stretch text-muted-foreground/60 hover:text-foreground"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
          >
            {collapsed ? (
              <ChevronRight size={11} aria-hidden="true" />
            ) : (
              <ChevronDown size={11} aria-hidden="true" />
            )}
          </button>
        )}
        {editor ? (
          // Inline rename (#170): the input replaces the two-line block in place.
          <div className="flex min-w-0 flex-1 items-center">{editor}</div>
        ) : (
          <button
            type="button"
            // leading-[normal]: the handoff rows run the font's natural line
            // height — the preflight 1.5 would grow the two-line block past
            // the 26px square and inflate every row (#64).
            className="flex min-w-0 flex-1 cursor-pointer flex-col gap-px text-left leading-[normal]"
            title={titleHint}
            onClick={onSelect}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px]',
                  // Selection lifts to semibold per the handoff; UNREAD keeps its
                  // email-style medium independent of selection (#126).
                  active ? 'font-semibold' : unread && 'font-medium',
                )}
                style={{ color: tints.title }}
              >
                {label}
              </span>
              {/* Unread is explicit copy instead of another blue dot. Blue dots
                  elsewhere mean live agent / git state, so a position-dependent
                  third meaning made completed rows look active (POD-236). */}
              {unread && !active && (
                <span
                  className="flex-none rounded-[4px] bg-info/15 px-1 text-[8px] font-semibold tracking-wide text-info uppercase"
                  role="img"
                  aria-label="Unread update"
                  title="New result since you last opened this issue"
                  data-testid="row-unread-chip"
                >
                  new message
                </span>
              )}
              {extras}
              {waitingCount > 0 && (
                <span
                  key={`pill:${waitingCount}`}
                  className={cn(
                    'flex-none rounded-full bg-attention px-[5px] text-[9px] font-bold text-attention-foreground',
                    morph !== null && 'morph-pop',
                  )}
                  role="img"
                  aria-label={`${waitingCount} waiting on you`}
                >
                  {waitingCount}
                </span>
              )}
            </span>
            <span
              className="flex min-w-0 items-center gap-1.5 text-[10px]"
              style={{ color: tints.status }}
            >
              {/* One lifecycle lockup is the row's first-glance answer. Agent
                  tiles remain identity-only; git renders only exceptions. */}
              <span
                className="flex min-w-0 flex-1 items-center gap-1.5"
                data-testid="row-lifecycle-status"
                data-phase={phase}
                style={
                  phase === 'working'
                    ? { color: 'var(--motion-working)' }
                    : phase === 'waiting'
                      ? { color: 'var(--motion-waiting)' }
                      : phase === 'done'
                        ? { color: 'var(--motion-total)' }
                        : undefined
                }
              >
                {phase === 'working' && <BrailleSpinner size={9} />}
                {phase === 'waiting' && (
                  <CircleAlert size={9} strokeWidth={2} className="flex-none" aria-hidden="true" />
                )}
                {phase === 'done' && (
                  <Check
                    size={10}
                    strokeWidth={2.4}
                    className="flex-none text-success"
                    aria-hidden="true"
                  />
                )}
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium">
                  {statusLine}
                </span>
                {timeMeta}
              </span>
              {gitStamp}
              {statusExtra}
            </span>
          </button>
        )}
        {/* Bridge notch (§2.5): grows from the selected row's right edge over the
            aside border toward the engraved column, tinted by the issue colour. */}
        {active && (
          <span
            data-testid="bridge-notch"
            aria-hidden="true"
            // issue-scope + var-driven gradient: a fresh colour pick animates
            // the notch through the registered --issue transition — gradient
            // images themselves can't interpolate.
            className="issue-scope pointer-events-none absolute top-[9px] right-[-10px] bottom-[9px] w-[10px] rounded-r-[3px]"
            style={
              {
                '--issue': accent,
                background: `linear-gradient(90deg, color-mix(in srgb, var(--issue) ${hex ? 85 : 75}%, transparent), color-mix(in srgb, var(--issue) ${hex ? 12 : 10}%, transparent))`,
              } as CSSProperties
            }
          />
        )}
      </div>
      {/* Agent roster band (L2): adjacent to the row, one tone tier below the
          panel, NEVER inside the subtask tree or behind the chevron. */}
      {/* Subtask rows (L1 — the chevron's one promise): a tree guide (vertical
          line + per-row stubs, via .tree-children CSS) ties the child ISSUES to
          their parent; sessions render in the band above. A coloured issue
          flows its tint into the unfolded block: a quiet wash behind the
          children, a tinted guide, and colour-mixed active/hover on the child
          rows — all via vars with neutral fallbacks so uncoloured rows (and
          every other PanelRow context) are untouched. */}
      {!collapsed && band && !hasTreeChildren && band}
      {!collapsed && hasTreeChildren && (
        <div
          className="tree-children relative rounded-b-[7px] pt-0.5 pb-1"
          data-drag-scope={childDragScope}
          data-testid={childrenTestId}
          style={
            hex
              ? ({
                  '--tree-guide': `color-mix(in srgb, ${hex} 55%, var(--border))`,
                  '--child-active-bg': `color-mix(in srgb, ${hex} 26%, #16161c)`,
                  '--child-hover-bg': `color-mix(in srgb, ${hex} 18%, #16161c)`,
                  // Same 12% mix as the unselected coloured row, so row +
                  // unfolded block read as one continuous coloured card.
                  background: `color-mix(in srgb, ${hex} 12%, #16161c)`,
                } as CSSProperties)
              : undefined
          }
        >
          <span
            className="tree-guide absolute top-0 bottom-3 left-4 w-px bg-[var(--tree-guide,var(--border))]"
            aria-hidden="true"
          />
          {band && <div data-tree-band>{band}</div>}
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * One issue row in the work list. Agent drafts (draft issue whose only content
 * is agents, no worktree) click straight into their session. Real issues show
 * the ID square and expand (default expanded) to their member sessions from 2
 * agents up.
 */
function UnifiedIssueRow({
  row,
  sessions: _all,
  issues,
  allWorktreePaths,
  selectedIssueId,
  paneA,
  now,
  onSelectIssue,
  onSelectPanelForIssue,
  onOpenIssue,
  onRenameIssue,
  onColorChangeIssue,
  onGripDown,
  /** Visual nesting depth for started-by children (0 = top-level). */
  startedByDepth = 0,
}: {
  row: UnifiedIssueRowView
  sessions: SessionMeta[]
  /** Whole issue list — the context menu's label pool / duplicate targets. */
  issues: IssueWire[]
  allWorktreePaths: string[]
  selectedIssueId: string | null
  paneA: string | null
  now: number
  onSelectIssue: (issue: IssueWire) => void
  onSelectPanelForIssue: (issue: IssueWire, sessionId: string) => void
  /** Open the issue PAGE (the context menu's "Open"). */
  onOpenIssue: (id: string) => void
  onRenameIssue: (id: string, title: string) => void
  onColorChangeIssue: (id: string, color: IssueColorSlot | null) => unknown
  /** Manual-sort drag start (POD-168); absent = row not draggable. */
  onGripDown?: (e: ReactPointerEvent, issueId: string) => void
  startedByDepth?: number
}): JSX.Element {
  const { issue, sessions: mine, startedByChildren = [] } = row
  const active = selectedIssueId === issue.id
  const unread = rowUnreadEmphasized(row)
  const [collapsed, toggle] = useCollapsed(`podium:sidebar:unified-issue:${issue.id}`, false)
  const [menuAnchor, setMenuAnchor] = useState<ContextMenuAnchor | null>(null)
  const [editing, setEditing] = useState(false)
  // Commit a rename: trim, and no-op on empty/whitespace or an unchanged title so
  // an accidental double-click that changes nothing never fires a mutation (#170).
  const commitRename = (name: string) => {
    const next = name.trim()
    if (next && next !== issue.title) onRenameIssue(issue.id, next)
    setEditing(false)
  }
  const renameEditor = editing ? (
    <SessionNameEditor
      value={issue.title}
      onCommit={commitRename}
      onCancel={() => setEditing(false)}
    />
  ) : undefined
  // Sessions earning visibility (multi-agent / remote spawn / native subagents)
  // render in the ADJACENT roster band (L2), never inside the issue tree. The
  // issue disclosure folds all detail while the compact fleet summary remains.
  const showSessions = sessionsNeedChildRows(mine)
  const hasStartedBy = startedByChildren.length > 0
  // Depth cap (L4): the sidebar renders parent + children, then numbers. A
  // depth-1 row never recurses — its whole subtree compresses into the quiet
  // roll-up line, counted over ALL descendants (parentId edges) so done
  // children that already decayed out of rows still show up in the k/m (L5).
  const capped = startedByDepth >= 1
  const rollup = capped ? branchRollup(issues, issue.id) : null
  const showRollup = rollup !== null && rollup.total > 0
  // A lone driver next to nested subtasks still shows in the band, so the
  // session doing the driving never vanishes behind plan structure.
  const showBand = showSessions || (hasStartedBy && mine.length > 0)
  const hasFoldableDetail = showBand || showRollup || (!capped && hasStartedBy)
  const { visible, stale } = partitionStaleSessions(mine, now)
  const phase = rowMotionPhase(row)
  const waitingCount = rowWaitingCount(row)
  const timing = rowMotionTiming(row)
  const hex = issueColorHex(issue.color)
  const square = (
    <IdSquare
      issue={issue}
      state={phase}
      selected={active}
      badge={waitingCount > 0 ? { kind: 'dot' } : null}
      onColorChange={(color) => onColorChangeIssue(issue.id, color)}
    />
  )
  // Spin-off provenance (POD-85): an outgoing discovered-from edge names the
  // issue this one was spun off from. One quiet ⤷ tick on line 2; selecting
  // the row flashes the origin.
  const originDep = issue.deps.find((d) => d.type === 'discovered-from')
  const origin = originDep ? issues.find((i) => i.id === originDep.id) : undefined
  // Draft vessel whose only content is agents → clicking opens the session.
  const draftAgentOnly = issue.draft && mine.length > 0 && !issue.worktreePath
  const first = mine[0]
  const label = issue.draft ? draftIssueLabel(issue, _all, allWorktreePaths) : issue.title
  const onContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault()
    setMenuAnchor({ x: e.clientX, y: e.clientY })
  }
  // The right-click menu (mirrors the board / SessionContextMenu pattern):
  // cursor-anchored portal, acts on this one issue, rendered alongside the row.
  const menu = menuAnchor ? (
    <IssueContextMenu
      issues={[issue]}
      allIssues={issues}
      surface="sidebar"
      anchor={menuAnchor}
      onClose={() => setMenuAnchor(null)}
      onOpen={(id) => {
        setMenuAnchor(null)
        onOpenIssue(id)
      }}
      onRename={() => {
        setMenuAnchor(null)
        setEditing(true)
      }}
    />
  ) : null
  const renderRow = (session: SessionMeta) => (
    <PanelRow
      key={session.sessionId}
      session={session}
      active={active && paneA === session.sessionId}
      onSelect={() => onSelectPanelForIssue(issue, session.sessionId)}
      dotRight
      roster
      coordinator={isCoordinatorSession(issue, session.sessionId)}
    />
  )
  // The rail-navy roster band (L2): AGENTS · N, adjacent to the row.
  const band =
    !draftAgentOnly && showBand ? (
      <AgentRosterBand label="Agents" count={mine.length} className="mt-0.5 mb-[3px] ml-8">
        <GroupedSessionRows sessions={visible} render={renderRow} dense />
        <StaleSection sessions={stale} render={renderRow} dense />
      </AgentRosterBand>
    ) : undefined
  return (
    <>
      <WorkRowShell
        testId={startedByDepth > 0 ? 'unified-issue-row-started-by' : 'unified-issue-row'}
        deemphasized={issue.audience === 'agent'}
        square={square}
        label={label}
        statusLine={
          issueAwaitingMerge(issue) ? (
            <span
              data-testid="awaiting-merge-status"
              className="inline-flex h-3 items-center gap-1 rounded-[3px] border border-attention/35 bg-attention/10 px-1 text-attention"
            >
              <GitBranch size={9} strokeWidth={1.8} aria-hidden="true" />
              ready to merge
            </span>
          ) : (
            rowStatusLine(row, now, capped ? 0 : 1)
          )
        }
        hex={hex}
        phase={phase}
        waitingCount={waitingCount}
        timeMeta={
          <PhaseTimer
            phase={timing.phase}
            sinceMs={timing.sinceMs}
            baseMs={timing.baseMs ?? 0}
            totalMs={timing.totalMs}
            size={9}
            showSpinner={false}
            plainLanguage
            leadingSeparator
            className="flex-none"
          />
        }
        active={draftAgentOnly ? active && paneA === first?.sessionId : active}
        gitStamp={
          issue.gitState && (
            <GitStamp
              issueBranch={issue.branch}
              git={issue.gitState}
              density="stamp"
              className="flex-none"
            />
          )
        }
        unread={unread}
        expandable={!draftAgentOnly && hasFoldableDetail}
        collapsed={draftAgentOnly || !hasFoldableDetail ? true : collapsed}
        onToggle={toggle}
        band={band}
        hasTreeChildren={showRollup || (!capped && hasStartedBy)}
        // A draft is just its agent — clicking the row opens the session itself.
        onSelect={
          draftAgentOnly && first
            ? () => onSelectPanelForIssue(issue, first.sessionId)
            : () => {
                if (origin) flashLineage(origin.id)
                onSelectIssue(issue)
              }
        }
        domMark={issue.id}
        onGripDown={onGripDown ? (e) => onGripDown(e, issue.id) : undefined}
        childDragScope={!capped && hasStartedBy ? `children:${issue.id}` : undefined}
        childrenTestId={!capped && hasStartedBy ? 'started-by-children' : undefined}
        statusExtra={
          origin && (
            <span
              className="flex-none font-mono text-[10px] tabular-nums"
              data-testid="spinoff-origin-tick"
              title={`Spun off from ${issueDisplayRef(origin)} · ${origin.title}`}
            >
              ⤷ {origin.seq}
            </span>
          )
        }
        onContextMenu={onContextMenu}
        onDoubleClick={() => setEditing(true)}
        editor={renameEditor}
        titleHint={issueIdTitle(issue)}
        extras={
          <>
            {/* The row's ref lives in the identity square alone (POD-85) — the
                muted repeat here doubled every row's ID for no added signal.
                Hover still surfaces the full ref via titleHint. */}
            {issue.audience === 'agent' && (
              <span
                className="flex-none rounded border border-slate-500/40 px-1 text-[8.5px] uppercase tracking-wide text-slate-500"
                data-testid="internal-issue-badge"
              >
                internal
              </span>
            )}
            {!draftAgentOnly && <IssueFleetSummary sessions={mine} />}
            {/* No started-by/epic jargon chips (POD-85): the dashed provenance
                nest and the expand chevron already say it visually. */}
            {issue.pinned && (
              <Pin size={10} className="flex-none text-muted-foreground" aria-hidden="true" />
            )}
            {isIssueSnoozed(issue, now) && (
              <AlarmClock
                size={10}
                className="flex-none text-muted-foreground"
                aria-label="Snoozed"
              />
            )}
            {issueReturnedFromDefer(issue, now) && (
              <span
                className="flex-none rounded border border-amber-500/40 px-1 text-[8.5px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400"
                title="Snooze ended — back in your queue"
              >
                Unsnoozed
              </span>
            )}
          </>
        }
      >
        {showRollup && rollup && (
          // Roll-up line (L4): depth beyond two levels becomes numbers. Mono,
          // faint, still; hover surfaces the affordance; click deep-links to
          // the issue page's subtask tree — no third indent, no camera modes.
          <button
            type="button"
            data-testid="subtree-rollup"
            className="group/rollup mb-0.5 ml-6 flex w-[calc(100%-2rem)] cursor-pointer items-center gap-1.5 rounded-[5px] px-1.5 py-0.5 text-left font-mono text-[9.5px] leading-[normal] text-muted-foreground/50 hover:bg-white/[.04] hover:text-muted-foreground"
            title={`Open ${issueIdTitle(issue)} subtask tree`}
            onClick={() => onOpenIssue(issue.id)}
          >
            └ {rollup.total} deeper · {rollup.done}/{rollup.total} done
            <span
              className="ml-auto flex-none text-[8.5px] opacity-0 transition-opacity duration-150 group-hover/rollup:opacity-100"
              aria-hidden="true"
            >
              open tree ↗
            </span>
          </button>
        )}
        {!draftAgentOnly &&
          !capped &&
          hasStartedBy &&
          startedByChildren.map((child) => (
            <div
              key={`issue:${child.issue.id}`}
              className="ml-5 min-w-0"
              data-drag-key={child.issue.id}
            >
              <UnifiedIssueRow
                row={child}
                allWorktreePaths={allWorktreePaths}
                sessions={_all}
                issues={issues}
                selectedIssueId={selectedIssueId}
                paneA={paneA}
                now={now}
                onSelectIssue={onSelectIssue}
                onSelectPanelForIssue={onSelectPanelForIssue}
                onOpenIssue={onOpenIssue}
                onRenameIssue={onRenameIssue}
                onColorChangeIssue={onColorChangeIssue}
                onGripDown={onGripDown}
                startedByDepth={startedByDepth + 1}
              />
            </div>
          ))}
      </WorkRowShell>
      {menu}
    </>
  )
}

/** Provenance whisper for an orphaned session (L6): a session whose issue was
 *  deleted or archived names its origin — `from POD-32 · deleted` — instead of
 *  silently pooling into an anonymous branch row. Presentation only; the
 *  data-layer orphan fix is POD-135. */
function orphanProvenance(
  session: SessionMeta,
  issues: IssueWire[],
): { text: string; hint: string } | null {
  if (!session.issueId) return null
  const issue = issues.find((i) => i.id === session.issueId)
  if (issue && !issue.archived && !issue.deletedAt) return null
  // Birth displayRef (POD-13-A) carries the issue ref even when the issue row
  // is gone from the wire entirely.
  const ref = issue ? issueDisplayRef(issue) : (session.displayRef?.replace(/-[A-Z]+$/, '') ?? null)
  const cause = issue ? (issue.deletedAt ? 'deleted' : 'archived') : 'deleted'
  return {
    text: ref ? `from ${ref} · ${cause}` : `issue ${cause}`,
    hint: `This session's issue was ${cause}; it decays on its own session clock.`,
  }
}

/** Sessions no live issue owns (L6): guests, not issues. The whole worktree
 *  entry renders in the roster grammar — a rail-navy band at its project
 *  group's tail labeled `repo · branch` in machine voice — never as a
 *  pseudo-issue row named "main". */
function UnifiedWorktreeRow({
  row,
  issues,
  active,
  paneA,
  now,
  onSelect,
  onSelectPanel,
}: {
  row: Extract<UnifiedWorkRow, { kind: 'worktree' }>
  issues: IssueWire[]
  active: boolean
  paneA: string | null
  now: number
  onSelect: () => void
  onSelectPanel: (sessionId: string) => void
}): JSX.Element {
  const { worktree } = row
  const { visible, stale } = partitionStaleSessions(worktree.sessions, now)
  const branch = worktree.branch ?? worktree.path.split('/').pop() ?? worktree.path
  const renderRow = (session: SessionMeta) => {
    const orphan = orphanProvenance(session, issues)
    return (
      <PanelRow
        key={session.sessionId}
        session={session}
        active={active && paneA === session.sessionId}
        onSelect={() => onSelectPanel(session.sessionId)}
        dotRight
        roster
        trailingMeta={
          orphan ? (
            <span
              className="flex-none font-mono text-[8.5px] text-[#525c78]"
              data-testid="orphan-provenance"
              title={orphan.hint}
            >
              {orphan.text}
            </span>
          ) : undefined
        }
      />
    )
  }
  return (
    <AgentRosterBand
      testId="unified-worktree-row"
      label={`${worktree.repoName} · ${branch}`}
      count={worktree.sessions.length}
      active={active}
      onLabelClick={onSelect}
      labelHint={worktree.path}
    >
      <GroupedSessionRows sessions={visible} render={renderRow} dense />
      <StaleSection sessions={stale} render={renderRow} dense />
    </AgentRosterBand>
  )
}
