import type { BuiltinHarnessKind, MachineId } from '@podium/model'
import { asMachineId } from '@podium/model/browser'
import { Plus } from 'lucide-react'
import { type JSX, useState } from 'react'
import { usePoolMachine } from '@/app/header-data'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { openSetupAgents } from '@/features/setup-agents/open-setup-agents'
import { MENU_HINT, MENU_ITEM, MENU_RULE, MENU_SECTION_LABEL } from './menu-surface'

type SetupMachine = { id: string; name: string }

export interface SetupAgentsMenuTarget {
  machineId?: string | null
  machines: readonly SetupMachine[]
  onStart?: (harness: BuiltinHarnessKind, machineId: MachineId) => void
}

/** Read progress from the target's shared inventory; menus own no install state. */
function InstallingHint({ machineId }: { machineId: string }): JSX.Element | null {
  const machine = usePoolMachine(machineId)
  const count =
    machine?.inventory?.agents.filter((agent) => agent.install?.managed?.installing).length ?? 0
  return count ? <span className={MENU_HINT}>{count} installing</span> : null
}

/** One footer for dropdowns and the cursor-anchored task menu. An unpinned
 * fleet asks for a machine first; the callback stays bound to that machine. */
export function SetupAgentsMenuItem({
  machineId,
  machines,
  onStart,
  variant = 'dropdown',
  onOpen,
}: SetupAgentsMenuTarget & {
  variant?: 'dropdown' | 'context'
  onOpen?: () => void
}): JSX.Element {
  const [choosingMachine, setChoosingMachine] = useState(false)
  const targetId = machineId ?? (machines.length === 1 ? machines[0]?.id : undefined)
  const open = (id: string): void => {
    const target = asMachineId(id)
    openSetupAgents({
      machineId: target,
      origin: 'menu',
      ...(onStart ? { onStart: (harness: BuiltinHarnessKind) => onStart(harness, target) } : {}),
    })
    onOpen?.()
  }
  const label = (
    <>
      <Plus className="size-3.5 flex-none text-text-dim" aria-hidden="true" />
      <span className="min-w-0 flex-1 whitespace-nowrap">Set up agents…</span>
      {targetId && <InstallingHint machineId={targetId} />}
    </>
  )
  if (variant === 'context') {
    return (
      <>
        <hr className={MENU_RULE} />
        <button
          type="button"
          role="menuitem"
          data-pressable
          disabled={!targetId && machines.length === 0}
          className={MENU_ITEM}
          aria-expanded={!targetId ? choosingMachine : undefined}
          onClick={() => (targetId ? open(targetId) : setChoosingMachine(!choosingMachine))}
        >
          {label}
        </button>
        {choosingMachine && !targetId && (
          <fieldset aria-label="Choose machine" className="m-0 min-w-0 border-0 p-0">
            <p className={MENU_SECTION_LABEL}>Choose machine</p>
            {machines.map((machine) => (
              <button
                type="button"
                role="menuitem"
                data-pressable
                key={machine.id}
                className={MENU_ITEM}
                onClick={() => open(machine.id)}
              >
                <span className="min-w-0 flex-1 truncate">{machine.name}</span>
                <InstallingHint machineId={machine.id} />
              </button>
            ))}
          </fieldset>
        )}
      </>
    )
  }
  return (
    <>
      <DropdownMenuSeparator />
      {targetId || machines.length === 0 ? (
        <DropdownMenuItem disabled={!targetId} onClick={() => targetId && open(targetId)}>
          {label}
        </DropdownMenuItem>
      ) : (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-56" aria-label="Choose machine">
            {machines.map((machine) => (
              <DropdownMenuItem key={machine.id} onClick={() => open(machine.id)}>
                <span className="min-w-0 flex-1 truncate">{machine.name}</span>
                <InstallingHint machineId={machine.id} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
    </>
  )
}
