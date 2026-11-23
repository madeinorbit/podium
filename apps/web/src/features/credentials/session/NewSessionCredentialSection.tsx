/**
 * "START ON A CREDENTIAL" IN THE NEW-PANEL MENU (credential management §9).
 *
 * The menu's agent rows start on the person's default, as they always did:
 * one click. This section is the choice: for each agent that has a credential
 * it can use on its machine, a submenu with those credentials and the
 * harness's own login, the default checked.
 */

import {
  type AcceptLine,
  initialCredential,
  sessionCredentialChoices,
} from '@podium/client-graph/session-credential-facts'
import type { AgentKind, CredentialId, MachineId } from '@podium/model'
import type { JSX, ReactNode } from 'react'
import {
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { MENU_SECTION } from '@/lib/menu-surface'
import { CredentialMenuItems } from './CredentialMenuItems'
import { useSessionCredentials } from './use-session-credentials'

export function NewSessionCredentialSection({
  agents,
  machineFor,
  acceptsOf,
  onCreate,
}: {
  agents: readonly { kind: AgentKind; label: string; icon: ReactNode }[]
  /** The machine an agent's row starts on; undefined when none can. */
  machineFor: (kind: AgentKind) => MachineId | undefined
  acceptsOf: (kind: AgentKind) => readonly AcceptLine[]
  onCreate: (kind: AgentKind, machineId: MachineId, credentialId: CredentialId | null) => void
}): JSX.Element | null {
  const { views, defaults, custodianOf } = useSessionCredentials()
  if (!views) return null
  const rows = agents.flatMap((agent) => {
    const machineId = machineFor(agent.kind)
    const accepts = acceptsOf(agent.kind)
    if (machineId === undefined || accepts.length === 0) return []
    const choices = sessionCredentialChoices({ views, accepts, machineId, custodianOf })
    if (choices.length === 0) return []
    return [
      { agent, machineId, choices, selected: initialCredential(choices, defaults[agent.kind]) },
    ]
  })
  if (rows.length === 0) return null
  return (
    <>
      <div className={MENU_SECTION}>START ON A CREDENTIAL</div>
      {rows.map(({ agent, machineId, choices, selected }) => (
        <DropdownMenuSub key={agent.kind}>
          <DropdownMenuSubTrigger>
            {agent.icon}
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
              {agent.label} on…
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-64">
            <CredentialMenuItems
              choices={choices}
              selected={selected}
              onSelect={(credentialId) => onCreate(agent.kind, machineId, credentialId)}
            />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ))}
    </>
  )
}
