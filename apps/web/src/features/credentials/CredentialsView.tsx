/**
 * THE CREDENTIALS PAGE as it renders from what it is given (credential
 * management §16 item 1): the list, the "add" menu, and the default for each
 * agent program. `CredentialsSection` reads the data and passes it in.
 */

import type { CredentialView } from '@podium/model'
import type { HarnessDescriptorWire } from '@podium/protocol'
import type { PodiumSettings } from '@podium/runtime'
import { ClipboardPaste, Plus } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { EntityRow, Section } from '@/features/settings/sections/shared'
import { useSettingsFrame } from '@/features/settings/settings-frame'
import { type AddEntry, registeredAddEntries } from './add-menu'
import { CredentialDetail } from './credential-detail'
import { listed, pasteTypes, typeTitle } from './credential-facts'
import { CredentialRow } from './credential-row'
import type { CredentialDeps } from './credentials-deps'
import { USE_ON_MY_MACHINES_NOTE } from './found-login-controls'
import { HarnessDefaults } from './harness-defaults'
import { PasteForm } from './paste-form'

/** The built-in entries: one per type obtained by pasting. */
export function pasteEntries(): AddEntry[] {
  return pasteTypes().map((type) => ({
    key: `paste:${type}`,
    label: typeTitle(type),
    hint:
      type === 'anthropic.claude-token'
        ? 'Paste a token from claude setup-token'
        : 'Paste a key from the provider',
    render: ({ deps, done }) => (
      <PasteForm mode={{ kind: 'add', type }} deps={deps} onDone={done} />
    ),
  }))
}

function AddChooser({ deps }: { deps: CredentialDeps }) {
  const { openTakeover, closeTakeover } = useSettingsFrame()
  const entries = [...pasteEntries(), ...registeredAddEntries()]
  return (
    <Section list>
      {entries.map((entry) => (
        <EntityRow
          key={entry.key}
          leading={<ClipboardPaste size={16} aria-hidden="true" />}
          title={entry.label}
          subtitle={entry.hint}
          onClick={() =>
            openTakeover({
              title: `Add ${entry.label}`,
              content: entry.render({ deps, done: closeTakeover }),
            })
          }
        />
      ))}
    </Section>
  )
}

export const CredentialsView = observer(function CredentialsView({
  views,
  loadError,
  deps,
  descriptors,
  settings,
  patch,
  children,
}: {
  /** `undefined` while the first read is in flight. */
  views: readonly CredentialView[] | undefined
  loadError?: string | null
  deps: CredentialDeps
  descriptors: readonly HarnessDescriptorWire[]
  settings: Pick<PodiumSettings, 'credentialDefaults'>
  patch: (patch: Partial<PodiumSettings>) => void
  children?: ReactNode
}) {
  const { openTakeover, closeTakeover } = useSettingsFrame()
  const rows = listed(views ?? [])
  const open = (view: CredentialView) =>
    openTakeover({
      title: view.label,
      content: <CredentialDetail view={view} deps={deps} onClose={closeTakeover} />,
    })
  return (
    <>
      <Section
        title="Your credentials"
        hint={[
          'Yours, and the ones others shared with you. Each one you add starts private to you.',
          rows.some((view) => view.nativeLogin?.useOnMyMachines !== undefined)
            ? USE_ON_MY_MACHINES_NOTE
            : '',
        ]
          .filter(Boolean)
          .join(' ')}
        list
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              openTakeover({ title: 'Add a credential', content: <AddChooser deps={deps} /> })
            }
          >
            <Plus size={14} aria-hidden="true" />
            Add
          </Button>
        }
      >
        {views === undefined && !loadError && (
          <p className="settings-list-note settings-prose" role="status">
            Loading credentials…
          </p>
        )}
        {loadError && (
          <p className="settings-list-note settings-prose text-destructive" role="alert">
            {loadError}
          </p>
        )}
        {views !== undefined && rows.length === 0 && !loadError && (
          <p className="settings-list-note settings-prose">
            None yet. Without one, each agent uses its own login on the machine.
          </p>
        )}
        {rows.map((view) => (
          <CredentialRow key={view.id} view={view} deps={deps} onOpen={open} />
        ))}
      </Section>
      <Section
        title="Default for each agent"
        hint="What a new session runs on when you do not pick a credential for it."
      >
        <HarnessDefaults
          views={rows}
          descriptors={descriptors}
          defaults={settings.credentialDefaults}
          patch={patch}
        />
      </Section>
      {children}
    </>
  )
})
