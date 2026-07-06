import type { AgentKind, IssueWire, SessionMeta } from '@podium/protocol'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import {
  draftIssueLabel,
  lastUsedMaps,
  panelLabel,
  partitionStaleSessions,
  partitionWorkItems,
  type RepoNavView,
  resolveDefaultAgent,
  sidebarSections,
  type UnifiedWorkRow,
  unifiedWorkList,
} from './derive'
import { HostIndicators } from './HostIndicators'
import { STAGE_LABELS } from './issue-card'
import { StageGlyph } from './issue-glyphs'
import { isEpic } from './issue-hierarchy'
import { NewIssueDialog } from './NewIssueDialog'
import { NEW_AGENTS } from './NewPanelMenu'
import {
  CollapsibleSection,
  PanelRow,
  PlainWorktreeBlock,
  repoPrimaryWorktree,
  StaleSection,
  useCollapsed,
} from './Sidebar'
import { useStore } from './store'
import { useNow } from './useNow'

/** Icon component for an agent kind (shared with the "+" menu's agent list). */
function agentIconFor(kind: AgentKind) {
  return NEW_AGENTS.find((a) => a.kind === kind)?.Icon
}

/**
 * The UNIFIED sidebar (issue-as-workspace, behind the temporary layout
 * switcher): one list of "pieces of work" — human-origin issues (drafts
 * first-class) plus worktrees no issue owns — topped by a low-friction
 * `New <Agent> in <Repo>` split button that spawns an agent into a draft issue.
 */
export function SidebarUnified(): JSX.Element {
  const {
    repos,
    sessions,
    pins,
    setPinned,
    issues,
    trpc,
    selectedWorktree,
    setSelectedWorktree,
    selectedIssueId,
    setSelectedIssueId,
    paneA,
    setPane,
    setView,
  } = useStore()
  const now = useNow(60_000)
  const [newIssueOpen, setNewIssueOpen] = useState(false)
  // The user's persisted default agent ('auto' resolves against session history).
  const [agentSetting, setAgentSetting] = useState<string | undefined>(undefined)
  useEffect(() => {
    let alive = true
    void trpc.settings.get
      .query()
      .then((s) => {
        if (alive) setAgentSetting(s.sessionDefaults.agent)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [trpc])

  const sections = sidebarSections(repos, sessions, pins, now, issues)
  const { byRepo } = lastUsedMaps(sections, sessions)
  const repoNavs: RepoNavView[] = [...sections.pinnedRepos, ...sections.repos]
  // <Repo> on the split button = the repo of the most recent session activity.
  const defaultRepo = repoNavs.reduce<RepoNavView | undefined>(
    (best, r) =>
      best === undefined || (byRepo.get(r.path) ?? 0) > (byRepo.get(best.path) ?? 0) ? r : best,
    undefined,
  )
  const defaultAgent = resolveDefaultAgent(agentSetting, sessions)
  const allWorktreePaths = repoNavs.flatMap((r) => r.worktrees.map((w) => w.path))
  const workRows = unifiedWorkList(sections, issues, sessions, allWorktreePaths, now)
  const workItems = partitionWorkItems(sessions, new Set(pins.panels), now)

  // A just-spawned draft session: once its broadcast lands with the server-minted
  // draft issueId, select that issue row (the id isn't known synchronously).
  const pendingSelect = useRef<string | null>(null)
  useEffect(() => {
    const sid = pendingSelect.current
    if (!sid) return
    const s = sessions.find((x) => x.sessionId === sid)
    if (s?.issueId) {
      setSelectedIssueId(s.issueId)
      pendingSelect.current = null
    }
  }, [sessions, setSelectedIssueId])

  /** Spawn `agentKind` in `repo`'s primary worktree inside a fresh draft issue. */
  async function spawn(agentKind: AgentKind, repo: RepoNavView): Promise<void> {
    const wt = repoPrimaryWorktree(repo)
    const { sessionId } = await trpc.sessions.create.mutate({
      agentKind,
      cwd: wt.path,
      draftIssue: { repoPath: repo.path },
      ...(wt.machineId ? { machineId: wt.machineId } : {}),
    })
    pendingSelect.current = sessionId
    // Same post-create plumbing as NewPanelMenu consumers: select + open.
    setSelectedWorktree(wt.path)
    setPane('A', sessionId)
    setView('workspace')
  }

  /** Persist a menu-picked agent as the new default (sessionDefaults.agent).
   *  'shell' isn't a valid session default — a shell pick spawns but doesn't
   *  change the sticky default. */
  async function persistDefaultAgent(kind: AgentKind): Promise<void> {
    if (kind === 'shell') return
    try {
      const current = await trpc.settings.get.query()
      const updated = await trpc.settings.set.mutate({
        ...current,
        sessionDefaults: { ...current.sessionDefaults, agent: kind },
      })
      setAgentSetting(updated.sessionDefaults.agent)
    } catch {
      setAgentSetting(kind) // optimistic — best-effort persistence
    }
  }

  const selectIssue = (issue: IssueWire) => {
    setSelectedIssueId(issue.id)
    if (issue.worktreePath) setSelectedWorktree(issue.worktreePath)
    setView('workspace')
  }
  const selectPanelForIssue = (issue: IssueWire, sessionId: string) => {
    selectIssue(issue)
    setPane('A', sessionId)
  }
  const selectWorktree = (path: string) => {
    setSelectedIssueId(null)
    setSelectedWorktree(path)
    setView('workspace')
  }
  const selectPanel = (worktreePath: string, sessionId: string) => {
    setSelectedIssueId(null)
    setSelectedWorktree(worktreePath)
    setPane('A', sessionId)
    setView('workspace')
  }

  return (
    <>
      {/* Row 1: split button `New <Agent> in <Repo>` + a separate "+" (new issue). */}
      <div className="mx-3 mt-2.5 flex items-center gap-1.5">
        <div className="flex min-w-0 flex-1 items-stretch overflow-hidden rounded-md border border-input bg-secondary">
          <button
            type="button"
            className="min-w-0 flex-1 truncate px-2.5 py-[7px] text-left text-[13px] text-foreground hover:bg-accent disabled:opacity-50"
            disabled={!defaultRepo}
            title={
              defaultRepo
                ? `Start a new ${panelLabel(defaultAgent)} agent in ${defaultRepo.name}`
                : 'No repos yet'
            }
            onClick={() => defaultRepo && void spawn(defaultAgent, defaultRepo)}
          >
            New {panelLabel(defaultAgent)} in {defaultRepo?.name ?? '…'}
          </button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className="flex-none border-l border-input px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="Choose agent and repo"
                >
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
              }
            />
            <DropdownMenuContent align="start" className="w-52">
              {NEW_AGENTS.map(({ kind, label, Icon }) => (
                <DropdownMenuSub key={kind}>
                  <DropdownMenuSubTrigger className="flex items-center gap-1.5">
                    <Icon size={14} aria-hidden="true" className="text-muted-foreground" />
                    {label}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {repoNavs.length === 0 && (
                      <DropdownMenuItem disabled>No repos</DropdownMenuItem>
                    )}
                    {repoNavs.map((repo) => (
                      <DropdownMenuItem
                        key={repo.path}
                        onClick={() => {
                          void persistDefaultAgent(kind)
                          void spawn(kind, repo)
                        }}
                      >
                        {repo.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="border border-input text-muted-foreground hover:border-primary hover:text-foreground"
          title="New issue"
          aria-label="New issue"
          onClick={() => setNewIssueOpen(true)}
        >
          <Plus size={15} aria-hidden="true" />
        </Button>
      </div>

      <div className="mt-1 flex-1 overflow-y-auto pb-3">
        {/* ── The existing work-item sections, unchanged ── */}
        {(workItems.attention.length > 0 ||
          workItems.working.length > 0 ||
          workItems.pinnedPanels.length > 0) && (
          <div className="min-w-0 border-b border-border">
            {workItems.attention.length > 0 &&
              (() => {
                const { visible, stale } = partitionStaleSessions(workItems.attention, now)
                const renderRow = (session: SessionMeta) => (
                  <PanelRow
                    key={session.sessionId}
                    session={session}
                    pinned={false}
                    attention
                    active={paneA === session.sessionId}
                    onSelect={() => selectPanel(session.cwd, session.sessionId)}
                    onPinned={(p) => void setPinned('panel', session.sessionId, p)}
                  />
                )
                return (
                  <CollapsibleSection
                    label="NEEDS YOUR ATTENTION"
                    storageKey="podium:sidebar:collapsed:attention"
                    count={workItems.attention.length}
                  >
                    {visible.map(renderRow)}
                    <StaleSection sessions={stale} render={renderRow} />
                  </CollapsibleSection>
                )
              })()}
            {workItems.working.length > 0 && (
              <CollapsibleSection
                label="WORKING"
                storageKey="podium:sidebar:collapsed:working"
                defaultCollapsed
                count={workItems.working.length}
              >
                {workItems.working.map((session) => (
                  <PanelRow
                    key={session.sessionId}
                    session={session}
                    pinned={false}
                    active={paneA === session.sessionId}
                    onSelect={() => selectPanel(session.cwd, session.sessionId)}
                    onPinned={(p) => void setPinned('panel', session.sessionId, p)}
                  />
                ))}
              </CollapsibleSection>
            )}
            {workItems.pinnedPanels.length > 0 && (
              <CollapsibleSection
                label="PINNED"
                storageKey="podium:sidebar:collapsed:pinned"
                count={workItems.pinnedPanels.length}
              >
                {workItems.pinnedPanels.map((session) => (
                  <PanelRow
                    key={session.sessionId}
                    session={session}
                    pinned={true}
                    active={paneA === session.sessionId}
                    onSelect={() => selectPanel(session.cwd, session.sessionId)}
                    onPinned={(p) => void setPinned('panel', session.sessionId, p)}
                  />
                ))}
              </CollapsibleSection>
            )}
          </div>
        )}

        {/* ── WORK LIST: human-origin issues (drafts included) ∪ unowned worktrees ── */}
        <div className="px-3 pt-3 pb-1">
          <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
            WORK
          </span>
        </div>
        {workRows.length === 0 && (
          <div className="p-3 text-xs text-muted-foreground/70">
            Nothing yet — start an agent or create an issue above.
          </div>
        )}
        {workRows.map((row) =>
          row.kind === 'issue' ? (
            <UnifiedIssueRow
              key={`issue:${row.issue.id}`}
              row={row}
              allWorktreePaths={allWorktreePaths}
              sessions={sessions}
              active={selectedIssueId === row.issue.id}
              paneA={paneA}
              now={now}
              onSelect={() => selectIssue(row.issue)}
              onSelectPanel={(sid) => selectPanelForIssue(row.issue, sid)}
              onPinned={(sid, p) => void setPinned('panel', sid, p)}
            />
          ) : (
            <PlainWorktreeBlock
              key={`wt:${row.worktree.path}`}
              worktree={row.worktree}
              pinned={false}
              active={selectedIssueId === null && selectedWorktree === row.worktree.path}
              paneA={paneA}
              now={now}
              setPinned={setPinned}
              onSelectWorktree={() => selectWorktree(row.worktree.path)}
              onSelectPanel={selectPanel}
            />
          ),
        )}
      </div>
      <HostIndicators />
      {newIssueOpen && <NewIssueDialog onClose={() => setNewIssueOpen(false)} />}
    </>
  )
}

/**
 * One issue row in the unified WORK LIST. Draft agent-vessels show the agent's
 * icon + the session's display title; real issues show the stage glyph + title
 * (adapted from IssueWorktreeBlock). The chevron expands the issue's sessions
 * (explicit issueId members first-class, cwd-contained legacy sessions folded in).
 */
function UnifiedIssueRow({
  row,
  sessions: _all,
  allWorktreePaths,
  active,
  paneA,
  now,
  onSelect,
  onSelectPanel,
  onPinned,
}: {
  row: Extract<UnifiedWorkRow, { kind: 'issue' }>
  sessions: SessionMeta[]
  allWorktreePaths: string[]
  active: boolean
  paneA: string | null
  now: number
  onSelect: () => void
  onSelectPanel: (sessionId: string) => void
  onPinned: (sessionId: string, pinned: boolean) => void
}): JSX.Element {
  const { issue, sessions: mine } = row
  const [collapsed, toggle] = useCollapsed(`podium:sidebar:unified-issue:${issue.id}`, true)
  const { visible, stale } = partitionStaleSessions(mine, now)
  // Draft vessel whose only content is agents → the agent's own icon; otherwise
  // the issue stage glyph.
  const draftAgentOnly = issue.draft && mine.length > 0 && !issue.worktreePath
  const AgentIcon = draftAgentOnly ? agentIconFor(mine[0]?.agentKind ?? 'claude-code') : undefined
  const label = issue.draft ? draftIssueLabel(issue, _all, allWorktreePaths) : issue.title
  const renderRow = (session: SessionMeta) => (
    <PanelRow
      key={session.sessionId}
      session={session}
      pinned={false}
      active={active && paneA === session.sessionId}
      onSelect={() => onSelectPanel(session.sessionId)}
      onPinned={(p) => onPinned(session.sessionId, p)}
    />
  )
  return (
    <div className="min-w-0" data-testid="unified-issue-row">
      <div className="group/uir flex min-w-0 items-stretch">
        {mine.length > 0 ? (
          <button
            type="button"
            className="flex-none px-1 text-muted-foreground/60 hover:text-foreground"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
          >
            {collapsed ? (
              <ChevronRight size={12} aria-hidden="true" />
            ) : (
              <ChevronDown size={12} aria-hidden="true" />
            )}
          </button>
        ) : (
          <span className="flex-none px-1">
            <ChevronRight size={12} className="invisible" aria-hidden="true" />
          </span>
        )}
        <button
          type="button"
          className={cn(
            'flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pr-3 text-left text-sm',
            active
              ? 'bg-accent font-medium text-accent-foreground'
              : 'text-foreground hover:bg-accent',
          )}
          onClick={onSelect}
        >
          {AgentIcon ? (
            <AgentIcon size={13} aria-hidden="true" className="flex-none text-muted-foreground" />
          ) : (
            <StageGlyph stage={issue.stage} size={13} />
          )}
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {label}
          </span>
          {isEpic(issue) && (
            <span className="flex-none rounded border border-violet-500/50 px-1 text-[9px] leading-4 text-violet-600 dark:text-violet-400">
              epic
            </span>
          )}
          {issue.childCount > 0 && (
            <span className="flex-none text-[10px] text-muted-foreground/70 tabular-nums">
              {issue.childDoneCount}/{issue.childCount}
            </span>
          )}
          {mine.length > 0 && (
            <span className="flex-none text-[10px] text-muted-foreground/70 tabular-nums">
              {mine.length}
            </span>
          )}
          {!issue.draft && (
            <span className="flex flex-none items-center gap-1 text-[10px] text-muted-foreground">
              {STAGE_LABELS[issue.stage]}
            </span>
          )}
        </button>
      </div>
      {!collapsed && (
        <>
          {visible.map(renderRow)}
          <StaleSection sessions={stale} render={renderRow} />
        </>
      )}
    </div>
  )
}
