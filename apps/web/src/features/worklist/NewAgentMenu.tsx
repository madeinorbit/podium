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
 * ---------------------------------------------------------------------------
 * A HARNESS IS THE THIRD AXIS (POD-1201)
 * ---------------------------------------------------------------------------
 *
 * `use` and liveness were the only two things this menu read, so every harness
 * the build knows about looked equally startable and `New Cursor` on a host with
 * no Cursor installed spawned a session that died on a missing binary. The tab
 * strip's "+" had been refusing that row for a while; the words and the rule now
 * come from `lib/agent-capability`, shared with it, so the same machine cannot
 * grey a row in one menu and offer it in the other.
 *
 * The reading is layered, because this menu is agent → repo → machine and each
 * level stands for a different set of hosts: the AGENT row asks whether anything
 * in the fleet can run it, a REPO row asks whether any host holding that repo
 * can, and a MACHINE row asks about that one host. A level whose host set is
 * unknown (a repo with no machines recorded — the ordinary local-daemon case)
 * stays offered rather than guessing.
 *
 * Gating here is UX only — the Authority re-authorizes at apply (ADR 3 D8).
 * Nothing in this file DECIDES anything; it only declines to offer.
 */
import type { MachineView, RepoNavView } from '@podium/client-core/viewmodels'
import type { AgentKind, MachineId, MachineWire } from '@podium/model/browser'
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
import {
  type AgentRowStatus,
  agentFleetStatus,
  candidateFromAvailability,
} from '@/lib/agent-capability'
import { MENU_HINT } from '@/lib/menu-surface'

/** The machines that hold one repo, as this principal may act on them. */
function viewsForRepo(
  repo: RepoNavView,
  machineViews: readonly MachineView<MachineWire>[],
): MachineView<MachineWire>[] {
  const repoMachineIds = new Set((repo.machines ?? []).map((m) => m.machineId))
  return machineViews.filter((view) => repoMachineIds.has(view.machine.id))
}

/** Every candidate host for one agent kind, with its refusal (if any) — the input
 *  the shared fleet reading takes. */
function candidatesFor(
  views: readonly MachineView<MachineWire>[],
  kind: AgentKind,
): ReturnType<typeof candidateFromAvailability>[] {
  return views.map((view) => candidateFromAvailability(view.machine, view.availability, kind))
}

/** The status for a row standing over `views`. An EMPTY set is unknowable, not
 *  refused: a repo with no machines recorded is the ordinary local-daemon case,
 *  and greying it would break single-user parity — the regression guard for the
 *  whole multi-user programme. */
function fleetStatus(
  views: readonly MachineView<MachineWire>[],
  kind: AgentKind,
  label: string,
): AgentRowStatus {
  if (views.length === 0) return {}
  return agentFleetStatus(candidatesFor(views, kind), label)
}

/**
 * One machine row, for one agent kind.
 *
 * The refusals get their own readings and are deliberately not merged:
 *   - available            — clickable, live dot.
 *   - `offline`            — refused, dimmed dot. Waiting may fix it.
 *   - `unauthorized`       — refused, LOCK. Waiting will never fix it.
 *   - `harness-missing`    — refused, dimmed dot, "not installed" (POD-1201).
 *     The host is reachable and yours; what is missing is the CLI, and that is
 *     the one of the three a person fixes by installing something.
 */
function MachineItem({
  view,
  kind,
  label,
  onSelect,
}: {
  view: MachineView<MachineWire>
  kind: AgentKind
  label: string
  onSelect: () => void
}): JSX.Element {
  const { machine, availability } = view
  const { reason, hint, warning } = agentFleetStatus(candidatesFor([view], kind), label)
  const unauthorized = availability === 'unauthorized'
  return (
    <DropdownMenuItem
      data-testid="new-agent-machine"
      data-availability={availability}
      data-refused={reason ? 'true' : undefined}
      disabled={reason !== undefined}
      title={reason ?? warning ?? `Start in ${machine.name}`}
      // Attention as INK, and it has to survive the hover — see the same note in
      // `lib/agent-capability`.
      className={
        warning && !reason ? 'text-warning hover:text-warning focus:text-warning' : undefined
      }
      onClick={reason === undefined ? onSelect : undefined}
    >
      {/* The lock and the status dot are readings rather than icons, so they
          keep their own small sizes — and say so with a `size-` class, the one
          thing the row's 14px glyph rule yields to. Both are indented into that
          same 14px column so the machine names still line up. */}
      {unauthorized ? (
        <Lock className="mx-[2px] size-2.5 flex-none text-text-faint" aria-hidden="true" />
      ) : (
        <Circle
          className={`mx-[4px] size-1.5 flex-none ${
            availability === 'available' ? 'fill-success text-success' : 'text-text-faint'
          }`}
          aria-hidden="true"
        />
      )}
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
        {machine.name}
      </span>
      {hint && <span className={MENU_HINT}>{hint}</span>}
    </DropdownMenuItem>
  )
}

/** The repo entries under one agent kind. A repo on a single machine is a flat
 *  row; a repo on several opens the machine submenu. */
function RepoItems({
  kind,
  label,
  menuRepos,
  machineViews,
  onPick,
}: {
  kind: AgentKind
  label: string
  menuRepos: RepoNavView[]
  machineViews: readonly MachineView<MachineWire>[]
  onPick: (kind: AgentKind, repo: RepoNavView, machineId?: MachineId) => void
}): JSX.Element {
  if (menuRepos.length === 0) return <DropdownMenuItem disabled>No repos</DropdownMenuItem>
  return (
    <>
      {menuRepos.map((repo) => {
        const repoViews = viewsForRepo(repo, machineViews)
        const { reason, hint } = fleetStatus(repoViews, kind, label)
        // One machine (or none recorded — the ordinary local-daemon case) keeps
        // the flat row it has always had: there is nothing to choose between.
        if (repoViews.length <= 1) {
          return (
            <DropdownMenuItem
              key={repo.path}
              data-refused={reason ? 'true' : undefined}
              disabled={reason !== undefined}
              title={reason}
              onClick={reason === undefined ? () => onPick(kind, repo) : undefined}
            >
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                {repo.name}
              </span>
              {hint && <span className={MENU_HINT}>{hint}</span>}
            </DropdownMenuItem>
          )
        }
        // No host under this repo can run the agent, so there is nothing to open
        // a submenu ONTO: it would list a column of refusals under a live-looking
        // trigger. The refusal is stated at this level instead.
        if (reason !== undefined) {
          return (
            <DropdownMenuItem key={repo.path} data-refused="true" disabled title={reason}>
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                {repo.name}
              </span>
              {hint && <span className={MENU_HINT}>{hint}</span>}
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
                  kind={kind}
                  label={label}
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
  /** The box the popup measures itself against. Optional: the collapsed rail
   *  opens this menu off a 34px tile, where anchoring to the trigger and
   *  letting `min-w-32` set the width is the only sane reading (POD-1178). */
  anchorRef?: RefObject<HTMLDivElement | null>
  menuRepos: RepoNavView[]
  machineViews: readonly MachineView<MachineWire>[]
  defaultRepo: RepoNavView | undefined
  onSpawn: (kind: AgentKind, repo: RepoNavView, machineId?: MachineId) => void
  onPersistDefaultAgent: (kind: AgentKind) => void
  onNewIssue: () => void
}): JSX.Element {
  /** A menu pick both persists the agent as the sticky default and spawns it —
   *  the two always travelled together, so they are one call here. */
  const pick = (kind: AgentKind, repo: RepoNavView, machineId?: MachineId): void => {
    onPersistDefaultAgent(kind)
    onSpawn(kind, repo, machineId)
  }
  return (
    <DropdownMenuContent align="start" sideOffset={4} anchor={anchorRef}>
      {NEW_AGENTS.map(({ kind, label, Icon }) => {
        const { reason, hint, warning } = fleetStatus(machineViews, kind, label)
        const glyph = <Icon aria-hidden="true" className="size-3.5 flex-none text-text-dim" />
        // Nothing in the fleet can run this harness, so the whole subtree under
        // it is refusals: the row says so once, here, instead of opening onto a
        // repo list every entry of which would also be dead.
        if (reason !== undefined) {
          return (
            <DropdownMenuItem key={kind} data-refused="true" disabled title={reason}>
              {glyph}
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                {label}
              </span>
              {hint && <span className={MENU_HINT}>{hint}</span>}
            </DropdownMenuItem>
          )
        }
        return (
          <DropdownMenuSub key={kind}>
            <DropdownMenuSubTrigger
              title={warning}
              className={warning ? 'text-warning hover:text-warning focus:text-warning' : undefined}
              onClick={() => defaultRepo && pick(kind, defaultRepo)}
            >
              {glyph}
              {label}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <RepoItems
                kind={kind}
                label={label}
                menuRepos={menuRepos}
                machineViews={machineViews}
                onPick={pick}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )
      })}
      {/* New issue lives in this menu now — the top row is a single control. */}
      <DropdownMenuItem onClick={onNewIssue}>
        <Plus aria-hidden="true" className="size-3.5 flex-none text-text-dim" />
        New task…
      </DropdownMenuItem>
    </DropdownMenuContent>
  )
}
