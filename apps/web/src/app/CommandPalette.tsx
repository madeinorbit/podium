import { shallowEqual } from '@podium/client-core/store'
import type { AgentKind, IssueWire } from '@podium/protocol'
import { resolveRole } from '@podium/runtime'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { STAGE_LABELS } from '@/features/issues/issue-card'
import { NewIssueDialog } from '@/features/issues/NewIssueDialog'
import {
  isSnoozed,
  lastUsedMaps,
  panelLabel,
  type RepoNavView,
  reposToViews,
  resolveDefaultAgent,
  sidebarSections,
  snoozeUntil1h,
  snoozeUntilTomorrow5am,
  spawnTargetForRepo,
} from '@/lib/derive'
import { useSessionGuard } from '@/lib/hooks/use-session-guard'
import { sessionMenuEligibility } from '@/lib/SessionContextMenu'
import { cn } from '@/lib/utils'
import {
  defaultHighlight,
  filterCommands,
  flattenGroups,
  moveHighlight,
  type PaletteCommand,
  type PaletteGroupId,
} from './command-palette'
import type { SpawnTarget } from './spawn-agent'
import { useStoreSelector } from './store'

const GROUP_LABELS: Record<PaletteGroupId, string> = {
  navigate: 'Navigate',
  global: 'Global',
  session: 'Session',
}

const SEARCH_DEBOUNCE_MS = 150
const SEARCH_MIN_QUERY_LEN = 2

/**
 * Debounced, race-guarded issue search over `trpc.issues.search` — merged into
 * the local navigate results once the query is ≥2 chars. Failures degrade
 * silently to local-only.
 */
function useIssueSearch(query: string, enabled: boolean): IssueWire[] {
  const trpc = useStoreSelector((s) => s.trpc)
  const [hits, setHits] = useState<IssueWire[]>([])
  const seq = useRef(0)
  useEffect(() => {
    const text = query.trim()
    const mySeq = ++seq.current
    if (!enabled || text.length < SEARCH_MIN_QUERY_LEN) {
      setHits((h) => (h.length === 0 ? h : []))
      return
    }
    const t = setTimeout(() => {
      trpc.issues.search
        .query({ text })
        .then((rows) => {
          if (seq.current === mySeq) setHits(rows)
        })
        .catch(() => {
          // Silent degrade: local navigate results still render.
          if (seq.current === mySeq) setHits((h) => (h.length === 0 ? h : []))
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [trpc, query, enabled])
  return hits
}

/**
 * App-wide Cmd/Ctrl+K command palette: Navigate (sessions, worktrees, issues —
 * local + server-searched), Global actions, and focused-session actions, with a
 * free-text "New agent" fallback that spawns via the shared draft-agent path.
 * Mounted once at shell level; the store's `paletteOpen` drives it.
 */
export function CommandPalette(): JSX.Element {
  const { paletteOpen, setPaletteOpen } = useStoreSelector(
    (s) => ({ paletteOpen: s.paletteOpen, setPaletteOpen: s.setPaletteOpen }),
    shallowEqual,
  )
  // The New-issue dialog outlives the palette (which closes on execute), so it
  // lives here as a sibling rather than inside the palette dialog.
  const [newIssueOpen, setNewIssueOpen] = useState(false)
  return (
    <>
      {paletteOpen && (
        <PaletteDialog
          onClose={() => setPaletteOpen(false)}
          onNewIssue={() => setNewIssueOpen(true)}
        />
      )}
      {newIssueOpen && <NewIssueDialog onClose={() => setNewIssueOpen(false)} />}
    </>
  )
}

function PaletteDialog({
  onClose,
  onNewIssue,
}: {
  onClose: () => void
  onNewIssue: () => void
}): JSX.Element {
  const {
    trpc,
    repos,
    sessions,
    issues,
    pins,
    setPinned,
    paneA,
    setPane,
    setView,
    setSelectedWorktree,
    setSelectedIssueId,
    setOpenIssueId,
    superOpen,
    setSuperOpen,
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
      issues: s.issues,
      pins: s.pins,
      setPinned: s.setPinned,
      paneA: s.paneA,
      setPane: s.setPane,
      setView: s.setView,
      setSelectedWorktree: s.setSelectedWorktree,
      setSelectedIssueId: s.setSelectedIssueId,
      setOpenIssueId: s.setOpenIssueId,
      superOpen: s.superOpen,
      setSuperOpen: s.setSuperOpen,
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
  const { guardedKill, guardedArchive } = useSessionGuard()
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

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

  const serverIssueHits = useIssueSearch(query, true)

  // Spawn targets for "New agent": the currently selected worktree AND the
  // sidebar "New <Agent> in <Repo>" button's default (the most recently active
  // repo's primary worktree) — both offered when they differ.
  const defaultAgent: AgentKind = resolveDefaultAgent(agentSetting, sessions)
  const spawnTargets = useMemo((): SpawnTarget[] => {
    const worktrees = reposToViews(repos).flatMap((r) => r.worktrees)
    const current = worktrees.find((w) => w.path === selectedWorktree)
    const sections = sidebarSections(repos, sessions, pins, Date.now(), issues)
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
  }, [repos, sessions, pins, issues, selectedWorktree])

  /** Close the palette, then run — optimistic close; errors toast downstream. */
  const execute = (run: () => void | Promise<void>): void => {
    onClose()
    void run()
  }

  const openSession = (sessionId: string, cwd: string, issueId?: string): void => {
    // A draft spawn passes its issue id so the draft-agent row is selected; plain
    // session navigation passes none (worktree selection, issue cleared).
    setSelectedIssueId(issueId ?? null)
    setSelectedWorktree(cwd)
    setPane('A', sessionId)
    setView('workspace')
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: run closures capture stable store actions
  const commands = useMemo((): PaletteCommand[] => {
    const out: PaletteCommand[] = []

    // ── Navigate: sessions ──
    for (const s of sessions) {
      if (s.archived) continue
      const wt = s.cwd.split('/').pop() ?? s.cwd
      out.push({
        id: `nav-session:${s.sessionId}`,
        group: 'navigate',
        label: s.name || s.title || `${panelLabel(s.agentKind)} session`,
        keywords: [wt, s.agentKind],
        hint: wt,
        run: () => openSession(s.sessionId, s.cwd),
      })
    }
    // ── Navigate: worktrees ──
    for (const repo of reposToViews(repos)) {
      for (const w of repo.worktrees) {
        out.push({
          id: `nav-worktree:${w.path}`,
          group: 'navigate',
          label: w.branch ?? (w.path.split('/').pop() || w.path),
          keywords: [repo.name, 'worktree'],
          hint: repo.name,
          run: () => {
            setSelectedIssueId(null)
            setSelectedWorktree(w.path)
            setView('workspace')
          },
        })
      }
    }
    // ── Navigate: issues (store's live list + server search hits, deduped) ──
    const localIds = new Set<string>()
    const issueCmd = (i: Pick<IssueWire, 'id' | 'title' | 'stage'>): PaletteCommand => ({
      id: `nav-issue:${i.id}`,
      group: 'navigate',
      label: i.title,
      keywords: ['issue'],
      hint: STAGE_LABELS[i.stage],
      run: () => {
        setOpenIssueId(i.id)
        setView('issues')
      },
    })
    for (const i of issues) {
      if (i.archived || i.deletedAt || i.draft) continue
      localIds.add(i.id)
      out.push(issueCmd(i))
    }
    for (const i of serverIssueHits) {
      if (!localIds.has(i.id)) out.push(issueCmd(i))
    }

    // ── Global ──
    out.push({
      id: 'global:new-issue',
      group: 'global',
      label: 'New task',
      keywords: ['create', 'add'],
      run: onNewIssue,
    })
    for (const target of spawnTargets) {
      out.push({
        id: `global:new-agent:${target.path}`,
        group: 'global',
        label: `New ${panelLabel(defaultAgent)} agent in ${target.path.split('/').pop()}`,
        keywords: ['session', 'spawn', 'start', 'new agent'],
        run: () => {
          // Optimistic (#119): the store paints the row instantly; navigate now.
          const { sessionId, issueId } = spawnDraftAgent({ target, agentKind: defaultAgent })
          openSession(sessionId, target.path, issueId)
        },
      })
    }
    const views = [
      ['home', 'Go to Home', ['attention', 'board']],
      ['issues', 'Go to Tasks', ['kanban', 'board', 'tracker']],
      ['workflows', 'Go to Workflows', ['agent', 'process', 'steps']],
      ['workspace', 'Go to Workspace', ['terminal', 'agents']],
      ['automations', 'Go to Automations', []],
      ['usage', 'Go to Usage', ['quota']],
      ['settings', 'Go to Settings', ['preferences', 'config']],
    ] as const
    for (const [view, label, keywords] of views) {
      out.push({
        id: `global:view-${view}`,
        group: 'global',
        label,
        keywords: [...keywords, 'switch', 'view'],
        run: () => setView(view),
      })
    }
    out.push({
      id: 'global:toggle-right-panel',
      group: 'global',
      label: superOpen ? 'Close superagent panel' : 'Open superagent panel',
      keywords: ['superagent', 'dock', 'btw', 'panel'],
      run: () => setSuperOpen(!superOpen),
    })

    // ── Session: actions on the focused session, same gates as the context menu ──
    const focused = paneA ? sessions.find((s) => s.sessionId === paneA) : undefined
    if (focused) {
      const id = focused.sessionId
      const { canHibernate, canResume, canClose } = sessionMenuEligibility(focused)
      const snoozed = isSnoozed(focused, Date.now())
      const pinned = pins.panels.includes(id)
      const sess = (cmd: Omit<PaletteCommand, 'group'>): void => {
        out.push({ ...cmd, group: 'session' })
      }
      sess({
        id: 'session:pin',
        label: pinned ? 'Unpin session' : 'Pin session',
        run: () => setPinned('panel', id, !pinned),
      })
      if (snoozed) {
        sess({ id: 'session:unsnooze', label: 'Un-snooze session', run: () => clearSnooze(id) })
      } else {
        sess({
          id: 'session:snooze-1h',
          label: 'Snooze session for 1 hour',
          run: () => setSnooze(id, snoozeUntil1h(Date.now())),
        })
        sess({
          id: 'session:snooze-tomorrow',
          label: 'Snooze session until tomorrow',
          run: () => setSnooze(id, snoozeUntilTomorrow5am(Date.now())),
        })
        sess({
          id: 'session:snooze-next',
          label: 'Snooze session until next message',
          run: () => setSnooze(id, null),
        })
      }
      if (canHibernate)
        sess({
          id: 'session:hibernate',
          label: 'Hibernate session',
          run: () => hibernateSession(id),
        })
      if (canResume)
        sess({ id: 'session:resume', label: 'Resume session', run: () => resurrectSession(id) })
      sess({
        id: 'session:btw',
        label: 'Ask superagent (BTW)',
        keywords: ['btw', 'superagent'],
        run: () => startBtw(id),
      })
      sess({
        id: 'session:archive',
        label: focused.archived ? 'Unarchive session' : 'Archive session',
        run: () => guardedArchive(id, !focused.archived),
      })
      if (canClose)
        sess({
          id: 'session:close',
          label: 'Close session',
          keywords: ['kill'],
          run: () => guardedKill(id),
        })
      sess({
        id: 'session:copy-id',
        label: 'Copy session id',
        run: () => navigator.clipboard?.writeText(id).catch(() => {}),
      })
    }
    return out
  }, [sessions, repos, issues, serverIssueHits, pins, paneA, spawnTargets, defaultAgent, superOpen])

  const groups = useMemo(() => filterCommands(query, commands), [query, commands])
  const flat = useMemo(() => flattenGroups(groups), [groups])
  // Rows = matches + the always-last free-text fallback rows (one per spawn
  // target, indices flat.length…). No fallback without targets (no repos yet).
  const rowCount = flat.length + spawnTargets.length

  // Re-highlight the top result whenever the result set changes.
  useEffect(() => {
    setHighlight(defaultHighlight(flat.length))
  }, [flat])

  // Keep the highlighted row visible as the roving selection moves.
  useEffect(() => {
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
      const target = spawnTargets[index - flat.length]
      if (target) runFallback(target)
    }
  }

  const onInputKeyDown = (e: React.KeyboardEvent): void => {
    const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'n')
    const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key.toLowerCase() === 'p')
    if (down || up) {
      e.preventDefault()
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

  let rowIndex = 0
  const itemCls = (active: boolean): string =>
    cn(
      'flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px]',
      active ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent',
    )

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
        // Top-third centered panel, not the default vertically-centered card.
        className="top-[18%] flex max-h-[min(480px,calc(100dvh-4rem))] w-[min(560px,100%)] max-w-none translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div className="border-b border-border p-2">
          <Input
            autoFocus
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-listbox"
            aria-activedescendant={`palette-item-${highlight}`}
            placeholder="Type a command or search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            className="border-none shadow-none focus-visible:ring-0"
          />
        </div>
        <div
          ref={listRef}
          id="palette-listbox"
          role="listbox"
          aria-label="Commands"
          className="flex-1 overflow-y-auto p-1.5"
        >
          {groups.map((g) => (
            <div key={g.group} className="mb-1">
              <div className="px-2.5 pt-1.5 pb-1 text-[10px] uppercase tracking-[0.06em] text-muted-foreground/60">
                {GROUP_LABELS[g.group]}
              </div>
              {g.commands.map((cmd) => {
                const idx = rowIndex++
                return (
                  <button
                    key={cmd.id}
                    id={`palette-item-${idx}`}
                    type="button"
                    role="option"
                    aria-selected={idx === highlight}
                    tabIndex={-1}
                    className={itemCls(idx === highlight)}
                    onMouseMove={() => setHighlight(idx)}
                    onClick={() => runRow(idx)}
                  >
                    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                      {cmd.label}
                    </span>
                    {cmd.hint && (
                      <span className="ml-auto flex-none text-[11px] text-muted-foreground/70">
                        {cmd.hint}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
          {/* Free-text fallback — always the last rows (and the only rows when
              nothing matches): spawn a new agent with the query as first prompt,
              one row per target (current worktree / last repo's primary). */}
          {spawnTargets.map((target, i) => {
            const idx = flat.length + i
            return (
              <button
                key={target.path}
                id={`palette-item-${idx}`}
                type="button"
                role="option"
                aria-selected={idx === highlight}
                tabIndex={-1}
                className={itemCls(idx === highlight)}
                onMouseMove={() => setHighlight(idx)}
                onClick={() => runRow(idx)}
              >
                <span className="flex-none rounded border border-input px-1 text-[10px] text-muted-foreground">
                  ↵
                </span>
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground">
                  New agent{query.trim() ? `: “${query.trim()}”` : ''}
                </span>
                <span className="ml-auto flex-none text-[11px] text-muted-foreground/70">
                  {target.path.split('/').pop()}
                </span>
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
