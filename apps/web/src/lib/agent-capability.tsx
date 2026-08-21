/**
 * WHAT A SPAWN ROW SAYS WHEN IT CANNOT SPAWN (POD-1201).
 *
 * ---------------------------------------------------------------------------
 * ONE VOCABULARY, EVERY AGENT MENU
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
 * The decision and its words now live in client-core rather than in any menu,
 * because desktop and mobile controls that phrase the same refusal differently
 * read as different systems. This module keeps the desktop row and tooltip;
 * `reason` remains both the disable decision and the sentence explaining it.
 *
 * ---------------------------------------------------------------------------
 * A CONDITION IS NOT A REFUSAL, AND IT IS NOT LOUDER THAN ONE (POD-1322)
 * ---------------------------------------------------------------------------
 *
 * A signed-out harness used to wear amber ink across the whole row. That put the
 * menu's loudest treatment on the one row that still works — `New OpenCode`
 * shouted while `New Cursor`, which cannot start at all, sat quietly greyed — and
 * greying it instead is not the fix either: greyed means `disabled` here, and the
 * pane a signed-out harness opens IS where you sign in. So the row stays live and
 * in normal ink, and the condition goes where refusals already live: two faint
 * words in the right-hand column, `signed out` beside `not installed`.
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
import {
  type AgentRowStatus,
  agentFleetStatus,
  spawnAgentLabel as agentLabel,
  candidateFromAvailability,
  agentCapabilityHint as capabilityHint,
  agentCapabilityReason as capabilityReason,
  agentLoginWarning as loginWarning,
  SIGNED_OUT_HINT,
} from '@podium/client-core/viewmodels'
import { Check } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { MENU_HINT } from '@/lib/menu-surface'

export {
  type AgentRowStatus,
  agentFleetStatus,
  agentLabel,
  candidateFromAvailability,
  capabilityHint,
  capabilityReason,
  loginWarning,
  SIGNED_OUT_HINT,
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
  selected = false,
  onSelect,
}: {
  icon: ReactNode
  label: string
  status: AgentRowStatus
  /** Marks a current choice when this shared refusal row is used as a picker. */
  selected?: boolean
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
        onClick={onSelect}
      >
        {icon}
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
          {label}
        </span>
        {hint && <span className={MENU_HINT}>{hint}</span>}
        {selected && <Check className="size-3 flex-none text-text-faint" aria-hidden="true" />}
      </DropdownMenuItem>
    </CapabilityTooltip>
  )
}

/**
 * A WHOLE PICKER of capability rows — the shared shape of every "which harness"
 * menu in the shell (POD-1457).
 *
 * `NewIssueDialog` owned a private copy of this; the launch box needed the same
 * list, and two menus that grey the same harness for the same reason must not be
 * two pieces of code. `modal={false}` matches the rest of the shell's property
 * menus: a modal dropdown locks body scroll, which fights a type-ahead's focus
 * on touch.
 */
export function CapabilityAgentMenu({
  trigger,
  options,
  selectedValue,
  onSelect,
  align = 'start',
}: {
  trigger: JSX.Element
  options: Array<{ value: string; label: string; icon?: ReactNode; status: AgentRowStatus }>
  selectedValue: string
  onSelect: (value: string) => void
  align?: 'start' | 'end'
}): JSX.Element {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align={align} className="w-56">
        {options.map((option) => (
          <CapabilityAgentItem
            key={option.value}
            icon={option.icon}
            label={option.label}
            status={option.status}
            selected={option.value === selectedValue}
            onSelect={() => onSelect(option.value)}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
