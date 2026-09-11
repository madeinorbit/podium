import { useEffect, useState } from 'react'
import { serverConfig } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { memberRequest } from '@/features/setup/member-api'
import { Section } from './shared'

type Member = { id: string; displayName: string; email: string | null; role: string }
type Invite = {
  id: string
  memberId: string | null
  email: string | null
  role: string
  expiresAt: string
}
type Members = {
  members: Member[]
  invites: Invite[]
  mailAvailable: boolean
  currentMemberId: string
}

export function MembersSection() {
  const origin = serverConfig(window.location).httpOrigin
  const [data, setData] = useState<Members>()
  const [email, setEmail] = useState('')
  const [memberId, setMemberId] = useState('')
  const [role, setRole] = useState('member')
  const [sendEmail, setSendEmail] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [link, setLink] = useState('')
  const [notice, setNotice] = useState('')
  const [removing, setRemoving] = useState<Member>()
  const reload = async () => setData(await memberRequest<Members>(origin, 'list'))
  useEffect(() => {
    void reload().catch((error: Error) => setError(error.message))
  }, [origin])
  async function mutate(action: string, body: unknown) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await memberRequest<{ url?: string; mailSent?: boolean }>(origin, action, body)
      if (result.url) {
        setLink(result.url)
        setNotice(
          sendEmail
            ? result.mailSent
              ? 'Invitation emailed.'
              : 'Email wasn’t sent. Copy the link below.'
            : 'Invitation ready to share.',
        )
      }
      setRemoving(undefined)
      await reload()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to save')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section
      title="Members"
      hint="Invite people to this workspace. Copy a link to share it with them."
    >
      {error && <p role="alert">{error}</p>}
      {data && (
        <div className="space-y-6">
          <ul className="space-y-3">
            {data.members.map((member) => (
              <li key={member.id} className="flex items-center justify-between gap-3">
                <div>
                  <strong>{member.displayName}</strong>
                  <p className="settings-prose">
                    {member.email || 'No email'} · {member.role}
                  </p>
                </div>
                {member.id !== data.currentMemberId && (
                  <Button variant="ghost" disabled={busy} onClick={() => setRemoving(member)}>
                    Remove {member.displayName}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {removing && (
            <div role="alertdialog" aria-label="Remove member" className="space-y-2">
              <p>
                Remove {removing.displayName}? They will lose access. Their issues and sessions will
                be kept.
              </p>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => void mutate('remove', { id: removing.id })}
              >
                Confirm removal
              </Button>
              <Button variant="ghost" onClick={() => setRemoving(undefined)}>
                Cancel
              </Button>
            </div>
          )}
          <form
            className="max-w-sm space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              void mutate('invite', {
                ...(memberId ? { memberId } : {}),
                ...(email.trim() ? { email } : {}),
                role,
                sendEmail,
              })
            }}
          >
            <h3 className="font-medium">Invite a member</h3>
            <label className="block">
              Member
              <select
                className="block w-full bg-background p-2"
                value={memberId}
                onChange={(e) => {
                  setMemberId(e.target.value)
                  const member = data.members.find((m) => m.id === e.target.value)
                  setEmail(member?.email ?? '')
                }}
              >
                <option value="">New member</option>
                {data.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              Email (optional)
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                maxLength={254}
              />
            </label>
            {!memberId && (
              <label className="block">
                Role
                <select
                  className="block w-full bg-background p-2"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
            )}
            {data.mailAvailable && (
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={sendEmail}
                  onChange={(e) => setSendEmail(e.target.checked)}
                />
                Send by email
              </label>
            )}
            <p className="settings-prose">Invitations expire in 7 days and can be used once.</p>
            <Button type="submit" disabled={busy || (sendEmail && !email.trim())}>
              Create invite
            </Button>
          </form>
          {link && (
            <div className="space-y-2">
              <p role="status">{notice}</p>
              <Input
                aria-label="Invite link"
                readOnly
                value={link}
                onFocus={(e) => e.target.select()}
              />
              <Button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(link)
                    setNotice('Link copied.')
                  } catch {
                    setNotice('Select the link above and copy it.')
                  }
                }}
              >
                Copy link
              </Button>
            </div>
          )}
          <div className="space-y-3">
            <h3 className="font-medium">Pending invitations</h3>
            {data.invites.length === 0 && <p className="settings-prose">No pending invitations.</p>}
            {data.invites.map((invite) => (
              <div key={invite.id} className="flex items-center justify-between gap-3">
                <span>
                  {invite.email || 'Shareable link'} · {invite.role} ·{' '}
                  {Date.parse(invite.expiresAt) <= Date.now()
                    ? 'Expired'
                    : `Expires ${new Date(invite.expiresAt).toLocaleDateString()}`}
                </span>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void mutate('revoke', { id: invite.id })}
                >
                  Revoke invite
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </Section>
  )
}
