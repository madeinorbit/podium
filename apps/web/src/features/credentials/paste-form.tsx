/**
 * ADD OR RENEW BY PASTING (credential management §6 way 1). The secret lives
 * only in this form's input while the person types; it is cleared the moment
 * the server accepts it and never rendered anywhere else. Afterwards the list
 * shows the masked identity the server stored.
 */

import type { CredentialTypeId, CredentialView } from '@podium/model'
import { type FormEvent, useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { pasteHint, typeTitle } from './credential-facts'
import { type CredentialDeps, errorText } from './credentials-deps'

export type PasteMode =
  | { kind: 'add'; type: CredentialTypeId }
  | { kind: 'renew'; credentialId: CredentialView['id']; type: CredentialTypeId; label: string }

export function PasteForm({
  mode,
  deps,
  onDone,
}: {
  mode: PasteMode
  deps: CredentialDeps
  onDone: () => void
}) {
  const id = useId()
  const title = typeTitle(mode.type)
  const [label, setLabel] = useState(mode.kind === 'add' ? title : mode.label)
  const [secret, setSecret] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = secret.trim().length > 0 && label.trim().length > 0 && !pending

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready) return
    setPending(true)
    setError(null)
    try {
      if (mode.kind === 'add') {
        await deps.commands.add.mutate({
          type: mode.type,
          label: label.trim(),
          secret: secret.trim(),
        })
      } else {
        await deps.commands.renew.mutate({ credentialId: mode.credentialId, secret: secret.trim() })
      }
      setSecret('')
      deps.reload()
      toast(mode.kind === 'add' ? `Added ${label.trim()}` : `Renewed ${mode.label}`)
      onDone()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="settings-measure flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
      <p className="settings-prose">{pasteHint(mode.type)}</p>
      {mode.kind === 'add' && (
        <label className="settings-label flex flex-col gap-1" htmlFor={`${id}-label`}>
          Name
          <Input
            id={`${id}-label`}
            value={label}
            maxLength={80}
            disabled={pending}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
      )}
      <label className="settings-label flex flex-col gap-1" htmlFor={`${id}-secret`}>
        {mode.kind === 'add' ? title : `New ${title}`}
        <Input
          id={`${id}-secret`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={secret}
          disabled={pending}
          onChange={(event) => setSecret(event.target.value)}
        />
      </label>
      <p className="settings-micro text-muted-foreground">
        Stored encrypted on the server. After this, Podium shows only a masked form of it.
      </p>
      {error && (
        <p className="settings-prose text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready} pending={pending} pendingLabel="Saving…">
          {mode.kind === 'add' ? 'Add' : 'Renew'}
        </Button>
      </div>
    </form>
  )
}
