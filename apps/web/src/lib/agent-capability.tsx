/** Shared harness rows: missing agents live in Set up agents; signed-out
 * agents stay selectable, and offline/probing refusals keep their hints. */
import {
  type AgentRowStatus,
  agentFleetStatus,
  spawnAgentLabel as agentLabel,
  agentMachineStatus,
  candidateFromAvailability,
  agentCapabilityHint as capabilityHint,
  agentCapabilityReason as capabilityReason,
  agentLoginWarning as loginWarning,
  SIGNED_OUT_HINT,
} from '@podium/client-core/values'
import { Check } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { MENU_HINT } from '@/lib/menu-surface'
import { useSelectTypeahead } from '@/lib/use-select-typeahead'
import { SetupAgentsMenuItem, type SetupAgentsMenuTarget } from './setup-agents-menu-item'

export {
  type AgentRowStatus,
  agentFleetStatus,
  agentLabel,
  agentMachineStatus,
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
}): JSX.Element | null {
  const { reason, warning, hint } = status
  if (status.hidden) return null
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
  typeahead = false,
  setup,
}: {
  trigger: JSX.Element
  options: Array<{ value: string; label: string; icon?: ReactNode; status: AgentRowStatus }>
  selectedValue: string
  onSelect: (value: string) => void
  align?: 'start' | 'end'
  typeahead?: boolean
  setup: SetupAgentsMenuTarget
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const visibleOptions = options.filter((option) => !option.status.hidden)
  const typing = useSelectTypeahead({
    enabled: typeahead && !open,
    options: visibleOptions.map((option) => ({
      ...option,
      disabled: option.status.reason !== undefined,
    })),
    selectedValue,
    onSelect,
  })
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger render={trigger} {...typing} />
      <DropdownMenuContent align={align} className="w-56">
        {visibleOptions.map((option) => (
          <CapabilityAgentItem
            key={option.value}
            icon={option.icon}
            label={option.label}
            status={option.status}
            selected={option.value === selectedValue}
            onSelect={() => onSelect(option.value)}
          />
        ))}
        <SetupAgentsMenuItem
          {...setup}
          onStart={(harness, machineId) => {
            if (setup.onStart) setup.onStart(harness, machineId)
            else onSelect(harness)
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
