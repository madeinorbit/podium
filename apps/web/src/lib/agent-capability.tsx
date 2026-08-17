/**
 * WHAT A SPAWN ROW SAYS WHEN IT CANNOT SPAWN (POD-1201).
 *
 * ---------------------------------------------------------------------------
 * ONE VOCABULARY, THREE MENUS
 * ---------------------------------------------------------------------------
 *
 * The shell offers "start an agent" from three places — the tab strip's "+"
 * (`app/NewPanelMenu`), the sidebar's `New <Agent> in <Repo>` chevron
 * (`features/worklist/NewAgentMenu`) and the flight deck's `Add agent`
 * (`app/FlightDeck`) — and until POD-1201 only the first one told the truth. The
 * other two listed every harness the build knows about, so `New Cursor` looked
 * exactly as startable as `New Claude` on a machine with no Cursor installed;
 * clicking it spawned a session that died on a missing binary, which is a
 * refusal delivered as a broken pane instead of as a greyed row.
 *
 * The words live here rather than in each menu because three menus a click apart
 * that phrase the same refusal three ways read as three different systems, and
 * because the enable/disable DECISION and the SENTENCE explaining it must not be
 * able to drift: `reason` is both, so a row cannot be disabled without saying
 * why, and cannot say why without being disabled.
 *
 * ---------------------------------------------------------------------------
 * WHY A ROW STATES ITS CASE INSTEAD OF DISAPPEARING
 * ---------------------------------------------------------------------------
 *
 * Same reasoning POD-821 used for the handoff menu: a harness that is simply
 * absent from the list is indistinguishable from one this build never supported,
 * so the user has nothing to act on. A greyed row with `not installed` on it
 * names the fix. Every refusal therefore carries a `hint` as well as a `reason`
 * — a tooltip is the one affordance a touch pointer never reaches, and these
 * rows exist to explain why they will not respond.
 *
 * Gating here is UX only; the Authority re-authorizes at apply (ADR 3 D8).
 */
import type {
  AgentCapabilityRejection,
  AgentLoginCondition,
  HandoffMachine,
} from '@podium/model/browser'
import { agentLoginCondition, harnessRejection } from '@podium/model/browser'
import type { JSX, ReactNode } from 'react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { MENU_HINT } from '@/lib/menu-surface'

/** How one agent row reads. `reason` set = the row refuses a click. */
export interface AgentRowStatus {
  /** The sentence, on hover. Set = disabled; see the module note. */
  reason?: string
  /** The short form, stated on the row itself for the pointer that never hovers. */
  hint?: string
  /** Amber, non-blocking: the spawn is allowed and will need something from you. */
  warning?: string
}

/** The agent's own name out of a menu label ("New Claude" → "Claude", "Claude
 *  Code (default)" → "Claude Code"), so a refusal reads as a sentence about the
 *  harness rather than about the row's copy. */
export function agentLabel(menuLabel: string): string {
  return menuLabel.replace(/^New /, '').replace(/ \(default\)$/, '')
}

export function capabilityReason(
  machineName: string,
  label: string,
  rejection: AgentCapabilityRejection | undefined,
): string | undefined {
  // Exhaustive on purpose: an unhandled rejection would return undefined, and
  // undefined ENABLES the row — so a new refusal reason would silently become
  // "spawn is fine". A `never` here makes adding one a compile error instead.
  switch (rejection) {
    case undefined:
      return undefined
    // §3.1.4 M5: spawn UI must not offer machines the principal lacks `use` on,
    // and denied must not read as offline — those need OPPOSITE responses, which
    // is why this one names the response and the next one does not: waiting fixes
    // an offline host and will never fix this.
    case 'unauthorized':
      return `You don’t have access to run agents on ${machineName}. Ask its owner.`
    case 'offline':
      return `${machineName} is offline.`
    case 'harness-missing':
      return `${agentLabel(label)} is not installed on ${machineName}.`
    default: {
      const exhaustive: never = rejection
      return exhaustive
    }
  }
}

/** The short form of a refusal, stated on the row itself. The tooltip carries the
 *  sentence; a touch pointer never opens a tooltip, so the row has to say enough
 *  on its own to explain why it will not respond. */
export function capabilityHint(
  rejection: AgentCapabilityRejection | undefined,
): string | undefined {
  switch (rejection) {
    case 'unauthorized':
      return 'no access'
    case 'offline':
      return 'offline'
    case 'harness-missing':
      return 'not installed'
    default:
      return undefined
  }
}

export function loginWarning(
  machineName: string,
  label: string,
  condition: AgentLoginCondition | undefined,
): string | undefined {
  return condition === 'logged-out'
    ? `${agentLabel(label)} isn’t logged in on ${machineName}; the session will open so you can log in in the pane.`
    : undefined
}

/** One candidate host for a spawn, as the fleet reading below needs it. */
export interface AgentCandidate {
  machineName: string
  /** Why this host refuses the agent, or `undefined` if it can run it. */
  rejection?: AgentCapabilityRejection
  /** The harness is installed here but signed out — startable, with a warning. */
  loggedOut?: boolean
}

/**
 * HOW A ROW THAT STANDS FOR A WHOLE FLEET READS.
 *
 * The tab strip's "+" names one machine per row, so its refusal names that
 * machine. The sidebar's agent row and the deck's `Add agent` stand for a SET of
 * candidate hosts, and a set has to be summarized without lying:
 *
 *   - any host can run it            → enabled (with a warning if every host
 *                                      that can is signed out).
 *   - one candidate                  → that host's own words, verbatim, so a
 *                                      single-machine deployment reads exactly
 *                                      like the tab strip does.
 *   - several, all missing the CLI   → "not installed", which names the fix.
 *   - several, mixed refusals        → "no host". Naming one machine's reason
 *                                      would be picking a representative
 *                                      arbitrarily, and "offline" on a row that
 *                                      also has an unauthorized host in it is
 *                                      the exact flattening M5 forbids.
 *   - no candidates at all           → "no host": nothing holds the repo yet.
 */
export function agentFleetStatus(
  candidates: readonly AgentCandidate[],
  label: string,
): AgentRowStatus {
  const agent = agentLabel(label)
  if (candidates.length === 0) {
    return { reason: `No machine here can run ${agent}.`, hint: 'no host' }
  }
  const usable = candidates.filter((candidate) => candidate.rejection === undefined)
  if (usable.length === 0) {
    const only = candidates.length === 1 ? candidates[0] : undefined
    if (only) {
      const reason = capabilityReason(only.machineName, label, only.rejection)
      const hint = capabilityHint(only.rejection)
      return { ...(reason ? { reason } : {}), ...(hint ? { hint } : {}) }
    }
    if (candidates.every((candidate) => candidate.rejection === 'harness-missing')) {
      return {
        reason: `${agent} is not installed on any available machine.`,
        hint: 'not installed',
      }
    }
    return { reason: `No available machine can run ${agent}.`, hint: 'no host' }
  }
  // Startable, but nowhere it can start is signed in. Worth saying up front: the
  // pane will open on a login prompt rather than on work.
  if (usable.every((candidate) => candidate.loggedOut)) {
    const first = usable[0]
    const warning = first
      ? loginWarning(
          usable.length === 1 ? first.machineName : 'any available machine',
          label,
          'logged-out',
        )
      : undefined
    return warning ? { warning } : {}
  }
  return {}
}

/**
 * A candidate built from a machine the client has already judged on `use` and
 * liveness (a `MachineView`), leaving only the harness dimension to read.
 *
 * The client resolves `use` per-LIST, not per-machine — an omitted `use` means
 * NOT EVALUATED, and reading that as denied would empty every single-machine
 * deployment's picker — so `availability` is the authorization reading here and
 * `agentCapabilityRejection` (which reads `machine.use` directly) is not what
 * this composes. The inventory rule itself still comes from `@podium/model`, so
 * this menu and the tab strip's cannot disagree about what "installed" means.
 *
 * AN ABSENT INVENTORY IS UNPROBED, NOT EMPTY. A daemon publishes its harness
 * inventory after it connects, so there is a window — and a whole class of
 * fixture and legacy payload — where the field is simply not there. Refusing on
 * it would grey EVERY agent row on a perfectly healthy single machine, which is
 * a worse lie than the one this file exists to fix, and it would break the
 * single-user parity that guards the multi-user programme. An inventory that IS
 * present is authoritative: a harness missing from it, or `installed: false`, is
 * refused.
 */
export function candidateFromAvailability<M extends HandoffMachine & { name: string }>(
  machine: M,
  availability: 'available' | 'unreachable' | 'unauthorized',
  agentKind: string,
): AgentCandidate {
  const rejection: AgentCapabilityRejection | undefined =
    availability === 'unauthorized'
      ? 'unauthorized'
      : availability === 'unreachable'
        ? 'offline'
        : machine.inventory === undefined
          ? undefined
          : harnessRejection(machine, agentKind)
  return {
    machineName: machine.name,
    ...(rejection ? { rejection } : {}),
    ...(rejection === undefined && agentLoginCondition(machine, agentKind) === 'logged-out'
      ? { loggedOut: true }
      : {}),
  }
}

/** The refusal sentence on a hoverable wrapper. A disabled `DropdownMenuItem` is
 *  `pointer-events-none`, so the reason has to hang off a live span around it. */
export function CapabilityTooltip({
  detail,
  children,
}: {
  detail: string | undefined
  children: ReactNode
}): JSX.Element {
  if (!detail) return <>{children}</>
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<span className="block pointer-events-auto" />}>
          {children}
        </TooltipTrigger>
        <TooltipContent side="right">{detail}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** One agent row in a spawn menu, wearing its capability reading. */
export function CapabilityAgentItem({
  icon,
  label,
  status,
  onSelect,
}: {
  icon: ReactNode
  label: string
  status: AgentRowStatus
  onSelect: () => void
}): JSX.Element {
  const { reason, warning, hint } = status
  return (
    <CapabilityTooltip detail={reason ?? warning}>
      <DropdownMenuItem
        data-testid="capability-agent-item"
        data-agent-label={label}
        data-refused={reason ? 'true' : undefined}
        disabled={reason !== undefined}
        // Attention as INK, and it has to survive the hover: the row's preset
        // lifts a hovered row to `--text-strong`, which would drop the one signal
        // the row exists to carry at exactly the moment the pointer is on it.
        className={
          warning && !reason ? 'text-warning hover:text-warning focus:text-warning' : undefined
        }
        onClick={onSelect}
      >
        {icon}
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
          {label}
        </span>
        {hint && <span className={MENU_HINT}>{hint}</span>}
      </DropdownMenuItem>
    </CapabilityTooltip>
  )
}
