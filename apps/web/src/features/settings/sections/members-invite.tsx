import { observer } from 'mobx-react-lite'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { memberRequest } from '@/features/setup/member-api'
import { useSettingsFrame } from '../settings-frame'
import { useSettingsClient } from '../stable-access'
import type { MembersPage } from './members-data'
import { MemberLinkResult } from './members-link-result'
import { MemberRoleControl } from './members-role'
import { ConfirmInline, Row, Section } from './shared'

export interface MemberLinkReceipt {
  url: string
  notice: string
}

export const InviteMember = observer(function InviteMember({
  data,
  origin,
  reload,
}: {
  data: MembersPage
  origin: string
  reload: () => Promise<unknown>
}) {
  const id = useId()
  const { closeTakeover } = useSettingsFrame()
  const { setSettingsTab } = useSettingsClient()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'member' | 'admin'>('member')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<MemberLinkReceipt>()
  const [emailed, setEmailed] = useState(false)
  // The server's sign-in edition decides delivery: a mail edition always emails the invitation.
  const mail = data.capabilities?.invitationDelivery === 'mail'
  const blocked = data.needsEmailBeforeInvite || (mail && !email.trim())
  const needsPassword = role === 'admin' && data.hasOwnCredential

  const invite = async (current = '') => {
    if (busy || blocked) return
    setBusy(true)
    setError(null)
    try {
      const answer = await memberRequest<{ url: string; mailSent?: boolean }>(origin, 'invite', {
        ...(email.trim() ? { email: email.trim() } : {}),
        role,
        ...(role === 'admin' ? { current } : {}),
      })
      if (mail) {
        if (!answer.mailSent)
          throw new Error('The invitation was not emailed. Try again or contact an admin.')
        setEmailed(true)
      } else setReceipt({ url: answer.url, notice: 'Invitation ready to share.' })
      await reload()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (needsPassword) throw cause
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  if (emailed)
    return (
      <Section title="Invitation sent">
        <p className="settings-prose" role="status">
          Invitation emailed.
        </p>
        <div className="mt-4 flex justify-end">
          <Button onClick={closeTakeover}>Done</Button>
        </div>
      </Section>
    )

  if (receipt)
    return (
      <Section title="Invite link">
        <MemberLinkResult label="Invite link" {...receipt} />
        <p className="settings-prose mt-4">The link works once and expires in 7 days.</p>
        <div className="mt-4 flex justify-end">
          <Button onClick={closeTakeover}>Done</Button>
        </div>
      </Section>
    )

  return (
    <>
      {data.needsEmailBeforeInvite && (
        <p className="settings-prose mb-4">
          Add your email address before inviting another person.{' '}
          <Button
            variant="link"
            className="h-auto p-0"
            onClick={() => {
              closeTakeover()
              setSettingsTab('account')
            }}
          >
            Add your email in Account
          </Button>
          .
        </p>
      )}
      <Section>
        <Row
          label="Email"
          description={
            mail
              ? 'Required. The invitation is emailed to this address.'
              : 'Optional. Without it you get a link to share yourself.'
          }
        >
          <label className="sr-only" htmlFor={`${id}-email`}>
            Email
          </label>
          <Input
            id={`${id}-email`}
            type="email"
            placeholder="name@example.com"
            maxLength={254}
            required={mail}
            value={email}
            disabled={busy}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Row>
        <Row label="Role" description="Admins manage members, machines and workspace settings.">
          <MemberRoleControl value={role} onChange={setRole} disabled={busy} />
        </Row>
      </Section>
      <p className="settings-prose mt-4">
        {mail ? 'The invitation' : 'The link'} works once and expires in 7 days.
      </p>
      {error && (
        <p className="settings-prose mt-2 text-destructive" role="alert">
          {error}
        </p>
      )}
      {needsPassword ? (
        <ConfirmInline
          sentence="Inviting an admin needs your password."
          actionLabel={mail ? 'Send invitation' : 'Create invite link'}
          hasPassword
          pending={busy}
          onConfirm={async (password) => {
            if (data.needsEmailBeforeInvite)
              throw new Error('Add your email address before inviting another person.')
            if (mail && !email.trim()) throw new Error('Enter an email address to send the invitation.')
            await invite(password)
          }}
          onCancel={closeTakeover}
        />
      ) : (
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={closeTakeover}>
            Cancel
          </Button>
          <Button
            disabled={busy || blocked}
            pending={busy}
            pendingLabel={mail ? 'Sending…' : 'Creating…'}
            onClick={() => void invite()}
          >
            {mail ? 'Send invitation' : 'Create invite link'}
          </Button>
        </div>
      )}
    </>
  )
})
