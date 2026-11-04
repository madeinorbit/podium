import { MemberDirectory, type MemberDirectoryAnswer } from '@podium/client-graph/member-directory'
import { useOpeningView } from '@podium/client-graph/react'
import type { MemberModel } from '@podium/client-graph/requested-models'
import { followVisibleRequest } from '@podium/client-graph/visible-request'
import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useState } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { serverConfig } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { memberRequest } from '@/features/setup/member-api'
import { Section } from './shared'

const createDirectory = (pool: import('@podium/client-graph/pool').MobxPool) =>
  new MemberDirectory(pool)

/** The member actions this section offers; `invite` is the form below. */
const MEMBER_ACTIONS = [
  'setRole',
  'disable',
  'enable',
  'recovery',
  'signOutEverywhere',
  'remove',
] as const
type MemberAction = (typeof MEMBER_ACTIONS)[number]
const isMemberAction = (action: string): action is MemberAction =>
  (MEMBER_ACTIONS as readonly string[]).includes(action)

function actionLabel(action: MemberAction, member: MemberModel, self: boolean): string {
  switch (action) {
    case 'setRole':
      return member.role === 'admin' ? 'Make member' : 'Make admin'
    case 'disable':
      return 'Disable'
    case 'enable':
      return 'Enable'
    case 'recovery':
      return 'Recovery link'
    case 'signOutEverywhere':
      return self ? 'Sign me out everywhere' : 'Sign out everywhere'
    case 'remove':
      return `Remove ${member.displayName}`
  }
}

const CONFIRM: Record<
  MemberAction,
  {
    title: string
    confirm: string
    password: boolean
    destructive: boolean
    prompt: (member: MemberModel, self: boolean) => string
  }
> = {
  setRole: {
    title: 'Change role',
    confirm: 'Confirm role change',
    password: true,
    destructive: false,
    prompt: (m) =>
      m.role === 'admin'
        ? `Make ${m.displayName} a member? They will no longer administer this instance.`
        : `Make ${m.displayName} an admin? They will manage members, machines and instance settings, but cannot open anyone’s sessions.`,
  },
  disable: {
    title: 'Disable member',
    confirm: 'Confirm disable',
    password: true,
    destructive: true,
    prompt: (m) =>
      `Disable ${m.displayName}? They are signed out and cannot sign in or act. Their history and the shares on their machines are kept.`,
  },
  enable: {
    title: 'Enable member',
    confirm: 'Confirm enable',
    password: true,
    destructive: false,
    prompt: (m) => `Enable ${m.displayName}? They can sign in again.`,
  },
  recovery: {
    title: 'Recovery link',
    confirm: 'Create recovery link',
    password: true,
    destructive: false,
    prompt: (m) =>
      `Create a link that sets a new password for ${m.displayName}? Using it signs them out everywhere.`,
  },
  signOutEverywhere: {
    title: 'Sign out everywhere',
    confirm: 'Confirm sign out',
    password: false,
    destructive: true,
    prompt: (m, self) =>
      self
        ? 'Sign yourself out on every device, this one included?'
        : `Sign ${m.displayName} out on every device? They can sign in again.`,
  },
  remove: {
    title: 'Remove member',
    confirm: 'Confirm removal',
    password: true,
    destructive: true,
    prompt: (m) =>
      `Remove ${m.displayName}? They will lose access. Their issues and sessions will be kept.`,
  },
}

/** The `/auth/members/*` route and body for one confirmed action. */
function requestFor(
  action: MemberAction,
  member: MemberModel,
  current: string,
): [string, Record<string, string>] {
  switch (action) {
    case 'setRole':
      return [
        'role',
        { id: member.id, role: member.role === 'admin' ? 'member' : 'admin', current },
      ]
    case 'signOutEverywhere':
      return ['sign-out-everywhere', { id: member.id }]
    default:
      return [action, { id: member.id, current }]
  }
}

export const MembersSection = observer(function MembersSection() {
  const origin = serverConfig(window.location).httpOrigin
  const data = useOpeningView(useWorklistPool(), createDirectory)
  const [email, setEmail] = useState('')
  const [memberId, setMemberId] = useState('')
  const [role, setRole] = useState('member')
  const [sendEmail, setSendEmail] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [link, setLink] = useState('')
  const [notice, setNotice] = useState('')
  // The member action waiting for the admin's confirmation (POD-6299).
  const [pending, setPending] = useState<{ action: MemberAction; member: MemberModel }>()
  // Role, disable, enable, removal and recovery need the admin's current password (POD-6298).
  const [current, setCurrent] = useState('')
  const reload = useCallback(
    () => data?.read(() => memberRequest<MemberDirectoryAnswer>(origin, 'list')),
    [data, origin],
  )
  useEffect(
    () =>
      followVisibleRequest(
        () => {
          if (!data?.loading) void reload()
        },
        {
          visible: () => document.visibilityState !== 'hidden',
          subscribe: (changed) => {
            document.addEventListener('visibilitychange', changed)
            return () => document.removeEventListener('visibilitychange', changed)
          },
        },
      ),
    [data, reload],
  )
  async function mutate(action: string, body: unknown) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await memberRequest<{ url?: string; mailSent?: boolean }>(origin, action, body)
      if (result.url) {
        setLink(result.url)
        setNotice(
          action === 'recovery'
            ? 'Recovery link ready. It sets a new password once, within 24 hours.'
            : sendEmail
              ? result.mailSent
                ? 'Invitation emailed.'
                : 'Email wasn’t sent. Copy the link below.'
              : 'Invitation ready to share.',
        )
      }
      setPending(undefined)
      setCurrent('')
      await reload()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to save')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section
      title="People"
      hint="Invite people, change their role, disable or remove them, and end their sign-ins."
    >
      {(error || data?.error) && <p role="alert">{error || data?.error}</p>}
      {data && (
        <div className="space-y-6">
          <ul className="space-y-3">
            {data.members.map((member) => (
              <li key={member.id} className="flex items-center justify-between gap-3">
                <div>
                  <strong>{member.displayName}</strong>
                  <p className="settings-prose">
                    {member.email || 'No email'} · {member.role}
                    {member.disabledAt ? ' · disabled' : ''}
                  </p>
                </div>
                {/* Only the actions the server says it would accept (POD-6299). */}
                <div className="flex flex-wrap justify-end gap-1">
                  {data
                    .actionsFor(member.id)
                    .filter(isMemberAction)
                    .map((action) => (
                      <Button
                        key={action}
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setError('')
                          setPending({ action, member })
                        }}
                      >
                        {actionLabel(action, member, member.id === data.currentMemberId)}
                      </Button>
                    ))}
                </div>
              </li>
            ))}
          </ul>
          {pending && (
            <div
              role="alertdialog"
              aria-label={CONFIRM[pending.action].title}
              className="space-y-2"
            >
              <p>
                {CONFIRM[pending.action].prompt(
                  pending.member,
                  pending.member.id === data.currentMemberId,
                )}
              </p>
              {CONFIRM[pending.action].password && (
                <label className="block max-w-sm">
                  Your password
                  <Input
                    type="password"
                    autoComplete="current-password"
                    value={current}
                    onChange={(e) => setCurrent(e.target.value)}
                  />
                </label>
              )}
              <Button
                variant={CONFIRM[pending.action].destructive ? 'destructive' : 'default'}
                disabled={busy}
                onClick={() => void mutate(...requestFor(pending.action, pending.member, current))}
              >
                {CONFIRM[pending.action].confirm}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setPending(undefined)
                  setCurrent('')
                }}
              >
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
                ...(role === 'admin' && !memberId ? { current } : {}),
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
                {data.members
                  .filter((m) => !m.disabledAt)
                  .map((m) => (
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
            {role === 'admin' && !memberId && (
              <label className="block">
                Your password
                <Input
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                />
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
})
