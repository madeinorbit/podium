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
import { type AgentKind, asMachineId, type MachineId } from '@podium/model/browser'
import { nativeAccountId, resolveRole } from '@podium/runtime'
import { ChevronDown, FolderPlus, Search } from 'lucide-react'
import type { JSX } from 'react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { openAddProject } from '@/app/desktop-menu'
import { useReplicaIssues, useSlice, useStoreSelector } from '@/app/store'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import {
  type AgentRowStatus,
  agentFleetStatus,
  candidateFromAvailability,
} from '@/lib/agent-capability'
import { agentBrandText, agentIconFor } from '@/lib/agent-tone'
import { MENU_HINT } from '@/lib/menu-surface'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { useFeature } from '@/lib/use-feature'
import { cn } from '@/lib/utils'
import { NewAgentMenu } from './NewAgentMenu'

// The dialog opens on a click and is mounted only while open, so nothing about
// it — its form, its stage vocabulary, its repo picker — is needed to paint the
// row that opens it. Same trade as the deferred context menus.
const NewIssueDialog = lazy(() =>
  import('@/features/issues/NewIssueDialog').then((module) => ({
    default: module.NewIssueDialog,
  })),
)

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
export function useDefaultSpawn(
  sectionsOverride?: SidebarSections,
  /**
   * Whether this caller owns the ⌘N chord. Exactly ONE mounted caller may
   * (POD-1058): the binding below is a window keydown listener plus a global
   * `__PODIUM_NEW_AGENT__` slot, so two live callers spawn two agents from one
   * press. It defaulted to "always" while the only callers were the wide row
   * and the collapsed rail, which are never mounted together — the work list's
   * empty state IS mounted under the row, so it takes the same spawn without
   * taking the chord.
   */
  { bindChord = true }: { bindChord?: boolean } = {},
) {
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
    if (!bindChord) return
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
  }, [bindChord])

  /**
   * WHETHER THE MAIN BUTTON'S OWN AGENT CAN ACTUALLY START (POD-1201).
   *
   * The button spawns `defaultAgent` into `defaultRepo` with no menu in between,
   * so it is a spawn affordance in its own right and gets the same reading the
   * menu rows get. Scoped to the hosts that hold the default repo — the button
   * names that repo, so a harness installed somewhere else in the fleet is not
   * an answer to "can this button run".
   */
  const defaultAgentStatus: AgentRowStatus = (() => {
    if (!defaultRepo) return {}
    const repoMachineIds = new Set((defaultRepo.machines ?? []).map((m) => m.machineId))
    const views = machineViews.filter((view) => repoMachineIds.has(view.machine.id))
    // No machines recorded for the repo is the ordinary local-daemon case, and
    // unknowable is not refused — see the note in `NewAgentMenu`.
    if (views.length === 0) return {}
    return agentFleetStatus(
      views.map((view) => candidateFromAvailability(view.machine, view.availability, defaultAgent)),
      panelLabel(defaultAgent),
    )
  })()

  return {
    defaultAgent,
    defaultRepo,
    defaultTarget,
    menuRepos,
    /** Machines with their verbs and availability — NOT the raw wire list. The
     *  submenu renders `unauthorized` and `unreachable` as different things. */
    machineViews,
    /** Why the one-click spawn is refused (or the warning it carries), scoped to
     *  the default repo's hosts. */
    defaultAgentStatus,
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
    defaultAgentStatus,
    spawn,
    persistDefaultAgent,
  } = useDefaultSpawn(sections)
  // The button's leading mark: the default harness's own glyph (POD-1281).
  const DefaultMark = agentIconFor(defaultAgent)
  const [newIssueOpen, setNewIssueOpen] = useState(false)
  // Anchor for the agent/repo menu: the WHOLE bordered button container, so the
  // dropdown opens directly under it, left-aligned, at the button's exact width
  // (the popup's w-(--anchor-width) tracks the Positioner anchor).
  const newAgentAnchorRef = useRef<HTMLDivElement | null>(null)

  return (
    // THE ARTBOARD'S BLOCK: `padding: 9px 10px 0` (POD-1253). 3a rules the block
    // off underneath; 3b — which is the composition we actually ship, because
    // the inline filter sits under this control — drops the rule and the bottom
    // padding and lets the field's own 8px top margin part the two. The block
    // was `10px 16px 8px 12px` and unruled, which is neither.
    //
    // 10px on the right is also exactly enough for the collapse control: it is
    // 18px wide at `translateX(50%)`, so it reaches 9px into this column and the
    // button's rim clears it by one.
    <div className="flex flex-none items-center gap-2 px-[10px] pt-[9px]">
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
          // so its control takes one).
          //
          // THE 3a CONTROL IS A RAISED CARD, NOT A RECESS (POD-1253). It was a
          // 30px `--secondary` chip with no rim — the POD-725 paper design's
          // answer, kept through the 3a redraw. The artboard makes it the
          // tallest thing in the column and the only RAISED one: 38px of inside
          // on a 1px rim, radius 8, on the same ground the selected row takes
          // (`#ffffff` on paper, `#23262d` in the dark artboard — which is what
          // `--chip` is in both). It is the column's one invitation, and it now
          // looks like one instead of like a search box.
          //
          // `h-10` = the artboard's 38px content plus its rim, since this box is
          // border-box; `px-[11px]` plus that rim is the mock's 12px inset. The
          // mock is content-box throughout — it declares `box-sizing:border-box`
          // exactly once, on its outer <section> — so every height in that file
          // has its border added on top of the number written.
          //
          // `pr-36` is the artboard's own right boundary for the label: 11px
          // inset + a 16px glyph + the row's 9px gap. An earlier cut spent 5 of
          // that gap on label width to stop a repo name truncating; measured,
          // the label has ~60px of slack at the column's default width and ~30
          // at its minimum, so the deviation bought nothing and the mock's
          // number stands (`e2e/pod1253-spawn-label.ts`).
          className={cn(
            'shell-spawn-chip flex h-10 w-full min-w-0 items-center gap-[9px] rounded-[8px] border border-border-strong bg-chip px-[11px] pr-[36px] text-[12.5px] font-medium tracking-[-0.005em] leading-[normal] text-foreground disabled:opacity-50',
            // The refusal is a DIM, not a colour: the row's own hue is the
            // agent's brand swatch, and greying is what every other refused
            // spawn affordance does. Warning ink is the exception — it is the
            // one state the operator has to act on before the pane is useful.
            defaultAgentStatus.warning && !defaultAgentStatus.reason && 'text-warning',
          )}
          disabled={!defaultRepo || defaultAgentStatus.reason !== undefined}
          // The refusal replaces the invitation. A button that still reads
          // "Start a new Cursor agent in podium" while refusing the click is
          // worse than one that says why (POD-1201).
          title={
            defaultAgentStatus.reason ??
            defaultAgentStatus.warning ??
            (defaultTarget
              ? `Start a new ${panelLabel(defaultAgent)} agent in ${defaultTarget.repoName}`
              : 'No repos yet')
          }
          onClick={() =>
            defaultRepo &&
            defaultAgentStatus.reason === undefined &&
            void spawn(defaultAgent, defaultRepo)
          }
        >
          {/* THE HARNESS'S OWN MARK, IN ITS BRAND TONE (POD-1281).
              POD-725 made this an 11px swatch — hue and nothing else — because a
              drawn logo competed with the ID squares two rows below it. In the
              shipped column it reads as an unexplained orange bubble instead: a
              colour nobody has been taught, sitting where the menu this button
              belongs to draws the Claude mark. The mark is the thing that says
              WHICH harness, so the row now wears the same glyph its own menu
              entry does, at the menu's 14px column, and the swatch's job is done
              by the glyph's own colour.
              A harness this build has no mark for keeps the swatch: inventing a
              glyph would claim a brand, and an unknown harness must still render
              something (see `agent-tone`). */}
          {DefaultMark ? (
            <DefaultMark
              size={14}
              aria-hidden="true"
              className={cn('flex-none', agentBrandText(defaultAgent))}
            />
          ) : (
            <span
              aria-hidden="true"
              className={cn(
                'size-[11px] flex-none rounded-[3px] bg-current',
                agentBrandText(defaultAgent),
              )}
            />
          )}
          <span className="min-w-0 truncate">
            New {panelLabel(defaultAgent)} in {defaultTarget?.repoName ?? '…'}
          </span>
          {/* Stated on the control, not only in its tooltip: the chevron beside
              it opens a menu where another harness may well work, and a dimmed
              button with no words is a dead end. */}
          {defaultAgentStatus.hint && <span className={MENU_HINT}>{defaultAgentStatus.hint}</span>}
        </button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            render={
              <button
                data-pressable
                type="button"
                className="absolute top-1/2 right-[7px] flex size-6 -translate-y-1/2 items-center justify-center rounded text-text-faint hover:text-foreground"
                aria-label="Choose agent and repo"
              >
                {/* 16px — the artboard's `expand_more`, which reads as the
                    control's second half rather than as a speck beside it. */}
                <ChevronDown size={16} aria-hidden="true" />
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
      {newIssueOpen && (
        <Suspense fallback={null}>
          <NewIssueDialog onClose={() => setNewIssueOpen(false)} />
        </Suspense>
      )}
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
  // THE ARTBOARD'S STRIP IS GLYPHS ON THE COLUMN'S INSET, 14px APART (POD-1253):
  // no cells, the first glyph starting at the same 13px every row title starts
  // at. Ours were 28px cells 4px apart, which put the first glyph at 19px — off
  // the column's one vertical datum — and drew two boxes in a strip the design
  // leaves as bare marks. The cell survives as the HIT TARGET only: it keeps its
  // 28px and pulls itself back by the 6px it is wider than its 16px glyph, so
  // the glyph lands on 13px and the pair sits 14px apart while the pointer still
  // gets a full control to hit.
  const btn = (active = false) =>
    cn(
      'flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-text-strong',
      '-mx-1.5',
      active && 'bg-muted text-text-strong',
    )
  return (
    <div className={cn('flex items-center gap-[14px]', className)}>
      <button
        data-pressable
        type="button"
        className={btn()}
        title="Add project"
        aria-label="Add project"
        onClick={openAddProject}
      >
        <FolderPlus size={16} aria-hidden="true" />
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
          <Search size={16} aria-hidden="true" />
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
