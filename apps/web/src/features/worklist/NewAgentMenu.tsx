/**
 * THE NEW-AGENT SUBMENU (POD-407) — agent → repo → machine, extracted from
 * `SidebarUnified`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT JUST A MENU
 * ---------------------------------------------------------------------------
 *
 * Every leaf here starts a process on somebody's hardware. Per
 * `docs/multi-user-readiness.md` §3.1.4, `use` is a CODE-EXECUTION boundary, not
 * a privacy one (M2): running an agent on someone's machine is arbitrary
 * execution with their SSH keys, git identity, cloud CLI sessions and whatever
 * private checkouts live there. So this menu FAILS CLOSED — it offers only what
 * {@link MachineView} reports as `available`.
 *
 * ---------------------------------------------------------------------------
 * UNAUTHORIZED IS NOT UNREACHABLE (M5)
 * ---------------------------------------------------------------------------
 *
 * Before this port the only axis was `online`, so a machine you may not use and
 * a machine that is asleep rendered identically — one disabled row, no reason.
 * M5 is explicit that they must be distinguishable, "since 'denied' and
 * 'offline' produce the same empty list otherwise". They need OPPOSITE responses
 * from a person: wake the machine up, versus ask its owner for access. A menu
 * that flattens them is lying by omission, and the user retries forever against
 * a door that was never going to open.
 *
 * Both are refused; only the WORDS differ. Neither is silently dropped, because
 * a machine that vanishes from the list is indistinguishable from a machine that
 * was never paired, and that is its own confusion (the same reasoning POD-821
 * used to make the handoff menu state its case instead of disappearing).
 *
 * Gating here is UX only — the Authority re-authorizes at apply (ADR 3 D8).
 * Nothing in this file DECIDES anything; it only declines to offer.
 */
import type { MachineView, RepoNavView } from '@podium/client-core/viewmodels'
import type { AgentKind, MachineWire } from '@podium/model'
import { Circle, Lock, Plus } from 'lucide-react'
import type { JSX, RefObject } from 'react'
import { NEW_AGENTS } from '@/app/NewPanelMenu'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'

/** The machines that hold one repo, as this principal may act on them. */
function viewsForRepo(
  repo: RepoNavView,
  machineViews: readonly MachineView<MachineWire>[],
): MachineView<MachineWire>[] {
  const repoMachineIds = new Set((repo.machines ?? []).map((m) => m.machineId))
  return machineViews.filter((view) => repoMachineIds.has(view.machine.id))
}

/**
 * One machine row.
 *
 * The three availabilities get three readings, and the two refusals are
 * deliberately not merged:
 *   - `available`   — clickable, live dot.
 *   - `unreachable` — refused, dimmed dot, "offline". Waiting may fix it.
 *   - `unauthorized`— refused, LOCK, "no access". Waiting will never fix it.
 */
function MachineItem({
  view,
  onSelect,
}: {
  view: MachineView<MachineWire>
  onSelect: () => void
}): JSX.Element {
  const { machine, availability } = view
  const unauthorized = availability === 'unauthorized'
  return (
    <DropdownMenuItem
      data-testid="new-agent-machine"
      data-availability={availability}
      disabled={availability !== 'available'}
      title={
        unauthorized
          ? `You do not have access to run agents on ${machine.name}. Ask its owner.`
          : availability === 'unreachable'
            ? `${machine.name} is offline.`
            : `Start in ${machine.name}`
      }
      onClick={availability === 'available' ? onSelect : undefined}
    >
      {unauthorized ? (
        <Lock size={9} className="text-muted-foreground/60" aria-hidden="true" />
      ) : (
        <Circle
          size={6}
          className={
            availability === 'available' ? 'fill-success text-success' : 'text-muted-foreground/40'
          }
          aria-hidden="true"
        />
      )}
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
        {machine.name}
      </span>
      {availability !== 'available' && (
        <span className="ml-1.5 flex-none text-[10px] text-muted-foreground/70">
          {unauthorized ? 'no access' : 'offline'}
        </span>
      )}
    </DropdownMenuItem>
  )
}

/** The repo entries under one agent kind. A repo on a single machine is a flat
 *  row; a repo on several opens the machine submenu. */
function RepoItems({
  kind,
  menuRepos,
  machineViews,
  onPick,
}: {
  kind: AgentKind
  menuRepos: RepoNavView[]
  machineViews: readonly MachineView<MachineWire>[]
  onPick: (kind: AgentKind, repo: RepoNavView, machineId?: string) => void
}): JSX.Element {
  if (menuRepos.length === 0) return <DropdownMenuItem disabled>No repos</DropdownMenuItem>
  return (
    <>
      {menuRepos.map((repo) => {
        const repoViews = viewsForRepo(repo, machineViews)
        // One machine (or none recorded — the ordinary local-daemon case) keeps
        // the flat row it has always had: there is nothing to choose between.
        if (repoViews.length <= 1) {
          return (
            <DropdownMenuItem key={repo.path} onClick={() => onPick(kind, repo)}>
              {repo.name}
            </DropdownMenuItem>
          )
        }
        return (
          <DropdownMenuSub key={repo.path}>
            <DropdownMenuSubTrigger onClick={() => onPick(kind, repo)}>
              {repo.name}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {repoViews.map((view) => (
                <MachineItem
                  key={view.machine.id}
                  view={view}
                  onSelect={() => onPick(kind, repo, view.machine.id)}
                />
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )
      })}
    </>
  )
}

/**
 * The dropdown body: one submenu per agent kind, plus `New task…`.
 *
 * The trigger and its anchor stay with the caller — this owns the CONTENT, which
 * is the part carrying the authorization reading.
 */
export function NewAgentMenu({
  anchorRef,
  menuRepos,
  machineViews,
  defaultRepo,
  onSpawn,
  onPersistDefaultAgent,
  onNewIssue,
}: {
  anchorRef: RefObject<HTMLDivElement | null>
  menuRepos: RepoNavView[]
  machineViews: readonly MachineView<MachineWire>[]
  defaultRepo: RepoNavView | undefined
  onSpawn: (kind: AgentKind, repo: RepoNavView, machineId?: string) => void
  onPersistDefaultAgent: (kind: AgentKind) => void
  onNewIssue: () => void
}): JSX.Element {
  /** A menu pick both persists the agent as the sticky default and spawns it —
   *  the two always travelled together, so they are one call here. */
  const pick = (kind: AgentKind, repo: RepoNavView, machineId?: string): void => {
    onPersistDefaultAgent(kind)
    onSpawn(kind, repo, machineId)
  }
  return (
    <DropdownMenuContent align="start" sideOffset={4} anchor={anchorRef}>
      {NEW_AGENTS.map(({ kind, label, Icon }) => (
        <DropdownMenuSub key={kind}>
          <DropdownMenuSubTrigger
            className="flex items-center gap-1.5"
            onClick={() => defaultRepo && pick(kind, defaultRepo)}
          >
            <Icon size={14} aria-hidden="true" className="text-muted-foreground" />
            {label}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <RepoItems
              kind={kind}
              menuRepos={menuRepos}
              machineViews={machineViews}
              onPick={pick}
            />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ))}
      {/* New issue lives in this menu now — the top row is a single control. */}
      <DropdownMenuItem onClick={onNewIssue}>
        <Plus size={14} aria-hidden="true" className="text-muted-foreground" />
        New task…
      </DropdownMenuItem>
    </DropdownMenuContent>
  )
}
