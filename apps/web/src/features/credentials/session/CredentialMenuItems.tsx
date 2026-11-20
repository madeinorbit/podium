/**
 * The rows every session credential menu shows: each credential the session
 * may run on (its label, then its kind and identity in a quieter ink; one that
 * needs attention disabled with why), then the harness's own login, always.
 */

import {
  type CredentialChoice,
  credentialKind,
  KIND_WORDS,
} from '@podium/client-graph/session-credential-facts'
import type { CredentialId } from '@podium/model'
import { Check } from 'lucide-react'
import type { JSX } from 'react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { identityText } from '../credential-facts'

export const OWN_LOGIN_HINT = 'Whatever it is signed in to on the machine'

function Row({
  label,
  hint,
  checked,
  disabled,
  onSelect,
}: {
  label: string
  hint: string | undefined
  checked: boolean
  disabled?: boolean
  onSelect: () => void
}) {
  return (
    <DropdownMenuItem disabled={disabled === true} onClick={onSelect}>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{label}</span>
        {hint ? (
          <span className="truncate text-[10.5px] leading-snug text-text-faint">{hint}</span>
        ) : null}
      </span>
      {checked ? (
        <Check className="ml-auto size-3 flex-none text-text-faint" aria-hidden="true" />
      ) : null}
    </DropdownMenuItem>
  )
}

export function CredentialMenuItems({
  choices,
  selected,
  onSelect,
  ownLogin = true,
}: {
  ownLogin?: boolean
  choices: readonly CredentialChoice[]
  /** The current value: an id, `null` for the own login, `undefined` for none shown. */
  selected: CredentialId | null | undefined
  onSelect: (value: CredentialId | null) => void
}): JSX.Element {
  return (
    <>
      {choices.map(({ view, disabled }) => {
        const kind = credentialKind(view.type)
        return (
          <Row
            key={view.id}
            label={view.label}
            hint={
              disabled ??
              [kind ? KIND_WORDS[kind] : undefined, identityText(view)].filter(Boolean).join(' · ')
            }
            checked={selected === view.id}
            disabled={disabled !== undefined}
            onSelect={() => onSelect(view.id)}
          />
        )
      })}
      {ownLogin && (
        <Row
          label={KIND_WORDS['own-login']}
          hint={OWN_LOGIN_HINT}
          checked={selected === null}
          onSelect={() => onSelect(null)}
        />
      )}
    </>
  )
}
