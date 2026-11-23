/**
 * THE CREDENTIAL CHIP WHERE A SESSION IS STARTED (credential management §9
 * "Choosing for a session"): next to model and effort, filled with the
 * person's default for the harness, listing only what that harness accepts and
 * what reaches the chosen machine, and always the harness's own login.
 *
 * A pick holds for the harness and machine it was made for. Change either and
 * the chip goes back to the default there (or the own login when the default
 * cannot run there), so it never shows a choice the launch would be refused.
 */

import {
  type AcceptLine,
  type CredentialChoice,
  type CustodianOf,
  initialCredential,
  KIND_WORDS,
  sessionCredentialChoices,
} from '@podium/client-graph/session-credential-facts'
import type { CredentialId, CredentialView } from '@podium/model'
import { KeyRound } from 'lucide-react'
import type { JSX } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { CredentialMenuItems } from './CredentialMenuItems'

/** A person's pick, and the harness and machine it was made for. */
export interface CredentialPick {
  readonly key: string
  readonly value: CredentialId | null
}

export interface CredentialPickInput {
  harness: string
  machineId: string | undefined
  driverId?: string
  /** Undefined until the list has loaded. */
  views: readonly CredentialView[] | undefined
  accepts: readonly AcceptLine[]
  defaultId: string | undefined
  custodianOf: CustodianOf
  pick: CredentialPick | undefined
}

export const credentialPickKey = (harness: string, machineId: string | undefined): string =>
  `${harness}|${machineId ?? ''}`

function choicesFor(input: CredentialPickInput): CredentialChoice[] {
  if (!input.views || input.machineId === undefined) return []
  return sessionCredentialChoices({
    views: input.views,
    accepts: input.accepts,
    machineId: input.machineId,
    ...(input.driverId !== undefined ? { driverId: input.driverId } : {}),
    custodianOf: input.custodianOf,
  })
}

function resolve(input: CredentialPickInput, choices: readonly CredentialChoice[]) {
  const pick = input.pick
  if (pick && pick.key === credentialPickKey(input.harness, input.machineId)) {
    if (pick.value === null) return null
    if (choices.some((c) => c.view.id === pick.value && !c.disabled)) return pick.value
  }
  return initialCredential(choices, input.defaultId)
}

/**
 * What the start sends: an id, `null` for the harness's own login, or
 * `undefined` while the list has not loaded (the server then applies the
 * person's default itself).
 */
export function shownCredential(input: CredentialPickInput): CredentialId | null | undefined {
  if (!input.views || input.machineId === undefined) return undefined
  return resolve(input, choicesFor(input))
}

export function CredentialPicker({
  className,
  onPick,
  ...input
}: CredentialPickInput & {
  onPick: (pick: CredentialPick) => void
  className?: string
}): JSX.Element {
  const choices = choicesFor(input)
  const value = shownCredential(input)
  const label =
    value === undefined
      ? 'Default credential'
      : value === null
        ? KIND_WORDS['own-login']
        : (choices.find((c) => c.view.id === value)?.view.label ?? 'Default credential')
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            data-pressable
            aria-label={`Credential: ${label}`}
            className={cn('inline-flex min-w-0 items-center gap-1.5', className)}
          >
            <KeyRound size={13} className="flex-none text-text-dim" aria-hidden="true" />
            <span className="min-w-0 truncate">{label}</span>
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-64">
        <CredentialMenuItems
          choices={choices}
          selected={value}
          onSelect={(next) =>
            onPick({ key: credentialPickKey(input.harness, input.machineId), value: next })
          }
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
