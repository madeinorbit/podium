import type { AgentRowStatus } from '@podium/client-core/values'
import { type JSX, type ReactNode, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CapabilityAgentItem } from '@/lib/agent-capability'
import { useSelectTypeahead } from '@/lib/use-select-typeahead'
import { SetupAgentsMenuItem, type SetupAgentsMenuTarget } from './setup-agents-menu-item'

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
          handBackKind="select"
          onStart={(harness, machineId) => {
            if (setup.onStart) setup.onStart(harness, machineId)
            else onSelect(harness)
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
