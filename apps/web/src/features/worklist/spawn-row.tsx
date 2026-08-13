import { shallowEqual } from '@podium/client-core/store'
import {
  lastUsedMaps,
  machineViewsFromWire,
  panelLabel,
  type RepoNavView,
  resolveDefaultAgent,
  resolveSpawnTargetMachine,
  type SidebarSections,
  spawnTargetForRepo,
  usableMachines,
  worklistSlice,
} from '@podium/client-core/viewmodels'
import { asMachineId, type AgentKind, type MachineId } from '@podium/model/browser'
import { nativeAccountId, resolveRole } from '@podium/runtime'
import { ChevronDown, FolderPlus, Search } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { openAddProject } from '@/app/desktop-menu'
import { useReplicaIssues, useSlice, useStoreSelector } from '@/app/store'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { NewIssueDialog } from '@/features/issues/NewIssueDialog'
import { agentBrandText } from '@/lib/agent-tone'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { useFeature } from '@/lib/use-feature'
import { cn } from '@/lib/utils'
import { NewAgentMenu } from './NewAgentMenu'

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
/**
 * The worklist derivation, as READ rather than as COMPUTED (POD-331).
 *
 * This used to be a `useMemo` over `(repos, sessions, pins, issues, now)` whose
 * result every consumer had to be HANDED as a `derivationOverride` prop — and
 * whose absence, in any consumer that did not receive it, silently bought a
 * second execution of the identical derivation on a private clock. It is now a
 * read of the published `worklistSlice`: one derivation per snapshot however
 * many surfaces are looking, and one clock (`Store.coarseNow`) so two surfaces
 * cannot disagree about when "now" is.
 *
 * The type alias stays so the override-taking signatures below keep reading the
 * same way; the shape is the slice's.

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
    }),
    shallowEqual,
  )
  const _issues = useReplicaIssues()
  const published = useSlice(worklistSlice)
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

  // The fallback is a READ of the published slice, not a second derivation
  // (POD-331). It used to be `sidebarSections(repos, sessions, pins, now, issues)`
  // on a private `useNow` clock, which is how a consumer that missed the prop
  // ended up deriving the worklist again against a different "now".
  const sections = sectionsOverride ?? published.sections
  const { byRepo } = lastUsedMaps(sections, sessions)
  const repoNavs: RepoNavView[] = [...sections.pinnedRepos, ...sections.repos]
  // <Repo> on the button = the repo of the most recent session activity.
  const defaultRepo = repoNavs.reduce<RepoNavView | undefined>(
    (best, r) =>
      best === undefined || (byRepo.get(r.path) ?? 0) > (byRepo.get(best.path) ?? 0) ? r : best,
    undefined,
  )
  // Machines as THIS principal may act on them: `see` already applied by the
  // server's per-principal projection, `use` read per-list (POD-407 / §3.1.4 M5).
  // Everything below picks targets out of these views rather than out of the raw
  // wire list, so an unauthorized machine is never a candidate in the first place.
  const machineViews = machineViewsFromWire(machines)

  // The spawn target is the repo's primary checkout on the default machine (MRU
  // for this repo, then first ONLINE machine the principal may USE).
  //
  // `resolveSpawnTargetMachine`, not `resolveTargetMachine`: the latter gates on
  // `online` alone, so it would happily resolve to a machine this principal has
  // no `use` grant on — a silently retargeted spawn, exactly the failure M5
  // forbids. The gated resolver applies `use` to the candidate set BEFORE the
  // pick, and says which of no-repo / unauthorized / unreachable it refused with.
  const spawnTarget = defaultRepo
    ? resolveSpawnTargetMachine(defaultRepo, sessions, machineViews)
    : undefined
  const defaultMachine = spawnTarget?.machineId
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
  /**
   * Resolve where this spawn lands, or `null` to refuse it outright.
   *
   * DENIED IS NOT THE SAME AS NO TARGET (§3.1.4 M5). An `unauthorized` refusal
   * must stop the spawn: falling through to the repo's primary checkout is the
   * "silently retargeted" failure M5 names. Every other outcome keeps today's
   * behaviour exactly — `no-repo` (nothing in the fleet holds this repo, the
   * ordinary single-machine and local-daemon case) and `unreachable` (holders
   * exist but none is online) both resolve to `undefined`, which
   * `spawnTargetForRepo` turns into the repo's own main checkout as it always
   * has. That split is what keeps single-user parity while closing the hole.
   */
  function resolveSpawnMachine(
    repo: RepoNavView,
    machineId?: MachineId,
  ): string | undefined | null {
    // An explicit pick is honoured only if it is still a machine this principal
    // may USE. The menu never offers an unauthorized one, but the views can go
    // stale between render and click (a grant revoked mid-menu).
    if (machineId !== undefined)
      return usableMachines(machineViews).some((m) => m.id === machineId) ? machineId : null
    const { machineId: resolved, refusal } = resolveSpawnTargetMachine(repo, sessions, machineViews)
    if (refusal === 'unauthorized') return null
    return resolved
  }

  function spawn(agentKind: AgentKind, repo: RepoNavView, machineId?: MachineId): void {
    const targetMachine = resolveSpawnMachine(repo, machineId)
    if (targetMachine === null) return
    const { worktree: wt } = spawnTargetForRepo(
      repo,
      targetMachine === undefined ? undefined : asMachineId(targetMachine),
    )
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
      const updated = await trpc.settings.updatePersonal.mutate({
        values: { 'roles.coding.accountId': nativeAccountId(kind) },
      })
      setAgentSetting(resolveRole(updated, 'coding').harness)
    } catch {
      setAgentSetting(kind) // optimistic — best-effort persistence
    }
  }

  // ⌘N — the same spawn as the New <Agent> in <Repo> button (POD-790).
  //
  // Two deliveries, one action. On a rebuilt macOS shell File > New Agent owns
  // the chord (an unclaimed accelerator never reaches the webview, same as
  // ⌘W before Close Tab) and evals `__PODIUM_NEW_AGENT__`. A keydown covers
  // every other native shell that actually hands us the event: Linux/Windows,
  // and a macOS binary old enough that no menu item claimed ⌘N yet.
  // Browser tabs are left alone — ⌘N / Ctrl+N open a window there.
  const newAgentRef = useRef<() => void>(() => {})
  newAgentRef.current = () => {
    if (defaultRepo) spawn(defaultAgent, defaultRepo)
  }
  useEffect(() => {
    if (!nativeDesktopBridge()) return
    const g = globalThis as { __PODIUM_NEW_AGENT__?: () => void }
    const handler = (): void => newAgentRef.current()
    g.__PODIUM_NEW_AGENT__ = handler
    const onKey = (event: KeyboardEvent): void => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'n'
      ) {
        event.preventDefault()
        handler()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      // Only ours: an expand/collapse swaps rail and row, and React mounts the
      // arriving one before unmounting the leaving one.
      if (g.__PODIUM_NEW_AGENT__ === handler) delete g.__PODIUM_NEW_AGENT__
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  return {
    defaultAgent,
    defaultRepo,
    defaultTarget,
    menuRepos,
    /** Machines with their verbs and availability — NOT the raw wire list. The
     *  submenu renders `unauthorized` and `unreachable` as different things. */
    machineViews,
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
    machineViews,
    spawn,
    persistDefaultAgent,
  } = useDefaultSpawn(sections)
  const [newIssueOpen, setNewIssueOpen] = useState(false)
  // Anchor for the agent/repo menu: the WHOLE bordered button container, so the
  // dropdown opens directly under it, left-aligned, at the button's exact width
  // (the popup's w-(--anchor-width) tracks the Positioner anchor).
  const newAgentAnchorRef = useRef<HTMLDivElement | null>(null)

  return (
    // The design's own block: 10px above the control, 8px below, 12px in from
    // the column edge, and NO rule under it (POD-725). It used to sit on the
    // shell's single horizontal datum (--section-bar-h) with a hairline, which
    // was the right call while every column started at the same y — but the
    // stage is a sheet inset 12px from the top now and the flight deck's own
    // header is 32px, so there is no shared datum left to hold. What the seam
    // was doing, the WORK label below it does better.
    // pr-4 clears the absolutely-positioned collapse control on the sidebar's
    // right edge (translateX(50%) into the content column).
    <div className="flex flex-none items-center gap-2 pt-2.5 pr-4 pb-2 pl-3">
      <div
        ref={newAgentAnchorRef}
        data-testid="new-agent-button"
        className="relative min-w-0 flex-1"
      >
        {/* One bordered rounded-lg surface with a leading Claude-clay agent icon;
            the chevron is a borderless hitbox floating inside the same outline. */}
        <button
          data-pressable
          type="button"
          // A fixed height, not py-2 (POD-365: the row is on the shell's datum,
          // so its control takes one). The design's 30px chip: no rim, a
          // `--secondary` fill and body ink — on paper that is the rail tone, so
          // the control reads as a recess in the column rather than a card
          // floating on it, and `data-pressable` supplies the hover lift.
          className="flex h-[30px] w-full min-w-0 items-center gap-2 rounded-lg bg-secondary px-[10px] pr-[32px] text-[12px] leading-[normal] text-foreground disabled:opacity-50"
          disabled={!defaultRepo}
          title={
            defaultTarget
              ? `Start a new ${panelLabel(defaultAgent)} agent in ${defaultTarget.repoName}`
              : 'No repos yet'
          }
          onClick={() => defaultRepo && void spawn(defaultAgent, defaultRepo)}
        >
          {/* A 10px rounded square in the agent's brand colour, not the agent's
              glyph (POD-725). At 14px the glyph competed with the ID squares
              two rows below it — three drawn marks in the same 30px column, one
              of which is not an issue. The design makes it a swatch: it names
              WHICH agent by hue and nothing else, and the words beside it
              already say the rest. */}
          <span
            aria-hidden="true"
            className={cn(
              'size-[10px] flex-none rounded-[3px] bg-current',
              agentBrandText(defaultAgent),
            )}
          />
          <span className="min-w-0 truncate">
            New {panelLabel(defaultAgent)} in {defaultTarget?.repoName ?? '…'}
          </span>
        </button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            render={
              <button
                data-pressable
                type="button"
                className="absolute top-1/2 right-[9px] flex size-6 -translate-y-1/2 items-center justify-center rounded text-text-faint hover:text-foreground"
                aria-label="Choose agent and repo"
              >
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            }
          />
          <NewAgentMenu
            anchorRef={newAgentAnchorRef}
            menuRepos={menuRepos}
            machineViews={machineViews}
            defaultRepo={defaultRepo}
            onSpawn={spawn}
            onPersistDefaultAgent={(kind) => void persistDefaultAgent(kind)}
            onNewIssue={() => setNewIssueOpen(true)}
          />
        </DropdownMenu>
      </div>
      {newIssueOpen && <NewIssueDialog onClose={() => setNewIssueOpen(false)} />}
    </div>
  )
}

/** Work-local tools: repository discovery and command search. Global utilities
 *  live in the top bar so they remain reachable outside the Work shell.
 *
 *  The Paper design writes these as the bare mono words `new task` and `search`.
 *  We keep the muted ICONS (operator call): the words would be the only prose in
 *  a column whose every other line is a task, and two of them at the foot of it
 *  read as list items rather than tools. What we do take from the design is the
 *  strip's geometry and the right-aligned ⌘K hint, so the footer still tells you
 *  the shortcut without spending a control on it. */
export function AppToolsRow({ className }: { className?: string }): JSX.Element {
  const setPaletteOpen = useStoreSelector((s) => s.setPaletteOpen)
  const commandPaletteEnabled = useFeature('command-palette')
  const btn = (active = false) =>
    cn(
      'flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-text-strong',
      active && 'bg-muted text-text-strong',
    )
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <button
        data-pressable
        type="button"
        className={btn()}
        title="Add project"
        aria-label="Add project"
        onClick={openAddProject}
      >
        <FolderPlus size={15} aria-hidden="true" />
      </button>

      {commandPaletteEnabled && (
        <button
          data-pressable
          type="button"
          className={btn()}
          title="Search (⌘K)"
          aria-label="Search"
          onClick={() => setPaletteOpen(true)}
        >
          <Search size={15} aria-hidden="true" />
        </button>
      )}
      {commandPaletteEnabled && (
        <span
          className="shell-type-micro mono-timer ml-auto flex-none text-text-faint"
          aria-hidden="true"
          data-testid="palette-hint"
        >
          ⌘K
        </span>
      )}
    </div>
  )
}
