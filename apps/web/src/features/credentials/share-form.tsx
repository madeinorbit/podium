/**
 * SHARING A CREDENTIAL (credential management §12). A grant to one member or
 * to every member. The person always acknowledges that whoever gets use can
 * read the secret; for a subscription (`sharing: 'warn'`) they also
 * acknowledge the provider-terms warning. Only `use` may go to every member.
 */

import { CREDENTIAL_SHARE_DISCLOSURE, CREDENTIAL_SHARE_WARNING } from '@podium/commands/credentials'
import { asUserId, type CredentialShare, type CredentialView } from '@podium/model'
import { type FormEvent, useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { typeSpecOf } from './credential-facts'
import { type CredentialDeps, errorText } from './credentials-deps'

const EVERYONE = 'all-members'

export function granteeText(share: CredentialShare, deps: CredentialDeps): string {
  return share.grantee === 'all-members'
    ? 'Everyone on this server'
    : (deps.nameOf(share.grantee.userId) ?? 'A member')
}

export function ShareForm({
  view,
  deps,
  onDone,
}: {
  view: CredentialView
  deps: CredentialDeps
  onDone: () => void
}) {
  const id = useId()
  const warn = typeSpecOf(view.type)?.sharing !== 'free'
  const people = deps.people.filter(
    (person) => person.id !== view.ownerUserId && person.id !== deps.currentUserId,
  )
  const [grantee, setGrantee] = useState<string>(EVERYONE)
  const [verb, setVerb] = useState<'use' | 'manage'>('use')
  const [disclosure, setDisclosure] = useState(false)
  const [warning, setWarning] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const everyone = grantee === EVERYONE
  const ready = disclosure && (!warn || warning) && !pending

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready) return
    setPending(true)
    setError(null)
    try {
      await deps.commands.share.mutate({
        credentialId: view.id,
        grantee: everyone ? 'all-members' : { userId: asUserId(grantee) },
        verb: everyone ? 'use' : verb,
        acknowledgeDisclosure: true,
        ...(warn ? { acknowledgeWarning: true } : {}),
      })
      deps.reload()
      toast(`Shared ${view.label}`)
      onDone()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      aria-label={`Share ${view.label}`}
      className="mt-2 mb-4 flex flex-col gap-3 border-l-2 border-border-strong py-2 pl-4"
      onSubmit={(e) => void submit(e)}
    >
      <label className="settings-label flex flex-col gap-1" htmlFor={`${id}-who`}>
        Share with
        <select
          id={`${id}-who`}
          className="h-8 max-w-72 rounded-md border border-border bg-background px-2 settings-prose"
          value={grantee}
          disabled={pending}
          onChange={(event) => setGrantee(event.target.value)}
        >
          <option value={EVERYONE}>Everyone on this server</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      </label>
      {!everyone && (
        <label className="settings-label flex flex-col gap-1" htmlFor={`${id}-verb`}>
          They may
          <select
            id={`${id}-verb`}
            className="h-8 max-w-72 rounded-md border border-border bg-background px-2 settings-prose"
            value={verb}
            disabled={pending}
            onChange={(event) => setVerb(event.target.value as 'use' | 'manage')}
          >
            <option value="use">Use it</option>
            <option value="manage">Use, rename, renew, share and remove it</option>
          </select>
        </label>
      )}
      <label className="settings-prose flex items-start gap-2" htmlFor={`${id}-disclosure`}>
        <Checkbox
          id={`${id}-disclosure`}
          checked={disclosure}
          disabled={pending}
          onCheckedChange={(value) => setDisclosure(value === true)}
        />
        <span>{CREDENTIAL_SHARE_DISCLOSURE}</span>
      </label>
      {warn && (
        <label className="settings-prose flex items-start gap-2" htmlFor={`${id}-warning`}>
          <Checkbox
            id={`${id}-warning`}
            checked={warning}
            disabled={pending}
            onCheckedChange={(value) => setWarning(value === true)}
          />
          <span className="text-warning">{CREDENTIAL_SHARE_WARNING}</span>
        </label>
      )}
      {error && (
        <p className="settings-prose text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!ready} pending={pending} pendingLabel="Sharing…">
          Share
        </Button>
      </div>
    </form>
  )
}
