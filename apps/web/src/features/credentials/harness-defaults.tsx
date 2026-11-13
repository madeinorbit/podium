/**
 * THE DEFAULT CREDENTIAL FOR EACH AGENT PROGRAM (credential management §9
 * "Choosing for a session"): the personal setting `credentialDefaults`. A new
 * session uses what its launch named, then this default, then the program's
 * own login on the machine. Each program is offered only the credentials of a
 * type it accepts, read from its descriptor's `accepts` lines.
 */

import type { CredentialView } from '@podium/model'
import type { HarnessDescriptorWire } from '@podium/protocol'
import type { HarnessAgent, PodiumSettings } from '@podium/runtime'
import { observer } from 'mobx-react-lite'
import { SelectRow } from '@/features/settings/sections/shared'
import { harnessChoices, identityText, typeTitle } from './credential-facts'

const OWN_LOGIN = 'own-login'

export const HarnessDefaults = observer(function HarnessDefaults({
  views,
  descriptors,
  defaults,
  patch,
}: {
  views: readonly CredentialView[]
  descriptors: readonly HarnessDescriptorWire[]
  defaults: PodiumSettings['credentialDefaults']
  patch: (patch: Partial<PodiumSettings>) => void
}) {
  const harnesses = descriptors.filter((descriptor) => descriptor.accepts.length > 0)
  if (harnesses.length === 0) return null
  return (
    <>
      {harnesses.map((descriptor) => {
        const harness = descriptor.kind as HarnessAgent
        const choices = harnessChoices(views, descriptor.accepts)
        const chosen = defaults[harness]
        const value = chosen ?? OWN_LOGIN
        const stale = chosen !== undefined && !choices.some((view) => view.id === chosen)
        const set = (next: string) => {
          const rest = { ...defaults }
          delete rest[harness]
          patch({
            credentialDefaults:
              next === OWN_LOGIN
                ? rest
                : { ...rest, [harness]: choices.find((view) => view.id === next)?.id },
          })
        }
        return (
          <SelectRow
            key={harness}
            setting="credentialDefaults"
            label={descriptor.label}
            description={
              stale
                ? 'The saved credential is not available any more. Pick another, or use its own login.'
                : `New ${descriptor.label} sessions use this unless you pick another when starting one.`
            }
            value={value}
            options={[
              {
                value: OWN_LOGIN,
                label: 'Its own login',
                hint: 'Whatever it is signed in to on the machine',
              },
              ...choices.map((view) => ({
                value: view.id as string,
                label: view.label,
                hint: [typeTitle(view.type), identityText(view)].filter(Boolean).join(' · '),
              })),
              ...(stale ? [{ value, label: 'Not available', disabled: true }] : []),
            ]}
            onChange={set}
          />
        )
      })}
    </>
  )
})
