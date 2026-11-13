/**
 * ONE CREDENTIAL, opened from its row by its owner or a holder of `manage`:
 * name, what it is, renew, who may use it, which other machines it may go to,
 * and remove (credential management §6, §7, §8, §12).
 */

import { type CredentialView, isCredentialTypeId } from '@podium/model'
import { Users } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { type FormEvent, useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  ConfirmInline,
  EntityRow,
  Row,
  Section,
  ValueRow,
} from '@/features/settings/sections/shared'
import {
  identityText,
  removalSentence,
  statusLines,
  typeSpecOf,
  typeTitle,
} from './credential-facts'
import { type CredentialDeps, errorText } from './credentials-deps'
import { MachineSend } from './machine-send'
import { PasteForm } from './paste-form'
import { granteeText, ShareForm } from './share-form'

function RenameForm({ view, deps }: { view: CredentialView; deps: CredentialDeps }) {
  const id = useId()
  const [label, setLabel] = useState(view.label)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed = label.trim().length > 0 && label.trim() !== view.label
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!changed || pending) return
    setPending(true)
    setError(null)
    try {
      await deps.commands.rename.mutate({ credentialId: view.id, label: label.trim() })
      deps.reload()
      toast('Renamed')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setPending(false)
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)}>
      <Row label="Name" error={error} description="The name you pick it by when starting work.">
        <div className="flex w-full gap-2">
          <Input
            id={`${id}-name`}
            aria-label="Name"
            value={label}
            maxLength={80}
            disabled={pending}
            onChange={(event) => setLabel(event.target.value)}
          />
          <Button type="submit" size="sm" variant="outline" disabled={!changed} pending={pending}>
            Rename
          </Button>
        </div>
      </Row>
    </form>
  )
}

function whereItLives(view: CredentialView, deps: CredentialDeps): string {
  const spec = typeSpecOf(view.type)
  if (spec?.store === 'vault') return 'Encrypted on this server'
  if (view.homes.length === 0) return 'Not signed in on any machine Podium knows of'
  return view.homes.map((home) => deps.machineName(home.machineId)).join(', ')
}

export const CredentialDetail = observer(function CredentialDetail({
  view,
  deps,
  onClose,
}: {
  view: CredentialView
  deps: CredentialDeps
  onClose: () => void
}) {
  const [renewing, setRenewing] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [unsharing, setUnsharing] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const spec = typeSpecOf(view.type)
  const renewable = spec?.obtain.includes('paste') === true && isCredentialTypeId(view.type)
  const lines = statusLines(view, {
    now: deps.now(),
    ownerName: deps.nameOf,
    machineName: deps.machineName,
  })
  const shares = view.sharedWith ?? []

  const unshare = async (index: number) => {
    const share = shares[index]
    if (!share) return
    setUnsharing(index)
    setError(null)
    try {
      await deps.commands.unshare.mutate({
        credentialId: view.id,
        grantee: share.grantee,
        verb: share.verb,
      })
      deps.reload()
      toast(`Stopped sharing with ${granteeText(share, deps)}`)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setUnsharing(null)
    }
  }

  return (
    <>
      <Section>
        <RenameForm view={view} deps={deps} />
        <ValueRow label="Kind" value={typeTitle(view.type)} />
        {identityText(view) && (
          <ValueRow
            label="Identity"
            value={<span className="font-mono">{identityText(view)}</span>}
          />
        )}
        <ValueRow
          label="Status"
          value={lines
            .filter((line) => line.tone !== 'muted')
            .map((line) => line.text)
            .join(' · ')}
        />
        <ValueRow label="Where it lives" value={whereItLives(view, deps)} />
        <ValueRow
          label="Sessions"
          value={
            view.sessionCount === 1 ? '1 session uses it' : `${view.sessionCount} sessions use it`
          }
        />
        {renewable && (
          <Row
            label="Renew"
            description="Replace the secret. Everything that uses this credential keeps using it."
          >
            <Button type="button" size="sm" variant="outline" onClick={() => setRenewing(true)}>
              Renew…
            </Button>
          </Row>
        )}
        {renewing && isCredentialTypeId(view.type) && (
          <div className="mt-2 mb-4 border-l-2 border-border-strong py-2 pl-4">
            <PasteForm
              mode={{ kind: 'renew', credentialId: view.id, type: view.type, label: view.label }}
              deps={deps}
              onDone={() => setRenewing(false)}
            />
          </div>
        )}
      </Section>
      <Section
        title="Who can use it"
        hint="Use is checked every time: take it back and their next session or call is refused."
        list
        action={
          !sharing && (
            <Button type="button" size="sm" variant="outline" onClick={() => setSharing(true)}>
              Share…
            </Button>
          )
        }
      >
        {sharing && <ShareForm view={view} deps={deps} onDone={() => setSharing(false)} />}
        {shares.length === 0 && !sharing && (
          <p className="settings-list-note settings-prose">Only you.</p>
        )}
        {shares.map((share, index) => (
          <EntityRow
            key={`${share.grantee === 'all-members' ? 'all' : share.grantee.userId}:${share.verb}`}
            leading={<Users size={16} aria-hidden="true" />}
            title={granteeText(share, deps)}
            subtitle={share.verb === 'manage' ? 'May use and manage it' : 'May use it'}
            trailing={
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={unsharing !== null}
                onClick={() => void unshare(index)}
              >
                Stop sharing
              </Button>
            }
          />
        ))}
        {error && (
          <p className="settings-list-note settings-prose text-destructive" role="alert">
            {error}
          </p>
        )}
      </Section>
      <Section
        title="Other machines"
        hint="It runs on the machines you look after. On a machine someone else looks after, it runs only if you send it there."
        list
      >
        <MachineSend view={view} deps={deps} />
      </Section>
      <Section title="Remove">
        <Row
          label="Remove this credential"
          description="Podium stops using it, and anyone you shared it with loses it."
        >
          <Button type="button" size="sm" variant="destructive" onClick={() => setRemoving(true)}>
            Remove…
          </Button>
        </Row>
        {removing && (
          <ConfirmInline
            sentence={`Remove ${view.label}? ${removalSentence(view.type)}`}
            actionLabel="Remove"
            destructive
            onCancel={() => setRemoving(false)}
            onConfirm={async () => {
              await deps.commands.remove.mutate({ credentialId: view.id })
              deps.reload()
              toast(`Removed ${view.label}`)
              onClose()
            }}
          />
        )}
      </Section>
    </>
  )
})
