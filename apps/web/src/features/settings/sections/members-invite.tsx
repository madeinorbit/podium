import { observer } from 'mobx-react-lite'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { memberRequest } from '@/features/setup/member-api'
import { useSettingsFrame } from '../settings-frame'
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
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'member' | 'admin'>('member')
  const [sendEmail, setSendEmail] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<MemberLinkReceipt>()
  const mail = data.mailAvailable && sendEmail
  const needsPassword = role === 'admin' && data.hasOwnCredential

  const invite = async (current = '') => {
    if (busy || (mail && !email.trim())) return
    setBusy(true)
    setError(null)
    try {
      const answer = await memberRequest<{ url: string; mailSent?: boolean }>(origin, 'invite', {
        ...(email.trim() ? { email: email.trim() } : {}),
        role,
        sendEmail: mail,
        ...(role === 'admin' ? { current } : {}),
      })
      setReceipt({
        url: answer.url,
        notice: mail
          ? answer.mailSent
            ? 'Invitation emailed.'
            : 'Email wasn’t sent. Copy the link below.'
          : 'Invitation ready to share.',
      })
      await reload()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (needsPassword) throw cause
      setError(message)
    } finally {
      setBusy(false)
    }
  }

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
      <Section title="Invitation">
        <Row label="Email" description="Optional. Without it you get a link to share yourself.">
          <label className="sr-only" htmlFor={`${id}-email`}>
            Email
          </label>
          <Input
            id={`${id}-email`}
            type="email"
            placeholder="name@example.com"
            maxLength={254}
            value={email}
            disabled={busy}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Row>
        <Row label="Role" description="Admins manage members, machines and workspace settings.">
          <MemberRoleControl value={role} onChange={setRole} disabled={busy} />
        </Row>
        {data.mailAvailable && (
          <Row label="Email the link" description="Sent from this workspace’s mail server.">
            <Switch
              aria-label="Email the link"
              checked={sendEmail}
              disabled={busy}
              onCheckedChange={setSendEmail}
            />
          </Row>
        )}
      </Section>
      <p className="settings-prose mt-4">The link works once and expires in 7 days.</p>
      {error && (
        <p className="settings-prose mt-2 text-destructive" role="alert">
          {error}
        </p>
      )}
      {needsPassword ? (
        <ConfirmInline
          sentence="Inviting an admin needs your password."
          actionLabel="Create invite link"
          hasPassword
          pending={busy}
          onConfirm={async (password) => {
            if (mail && !email.trim()) throw new Error('Enter an email address to email the link.')
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
            disabled={busy || (mail && !email.trim())}
            pending={busy}
            pendingLabel="Creating…"
            onClick={() => void invite()}
          >
            Create invite link
          </Button>
        </div>
      )}
    </>
  )
})
