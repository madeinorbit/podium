import type { MemberDirectoryAnswer } from '@podium/client-graph/member-directory'
import type { MemberRosterAnswer } from '@podium/client-graph/member-roster'
import { useOpeningView } from '@podium/client-graph/react'
import type { MemberModel } from '@podium/client-graph/requested-models'
import { followVisibleRequest } from '@podium/client-graph/visible-request'
import { Link, Plus } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { serverConfig } from '@/app/trpc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { authRequest, memberRequest } from '@/features/setup/member-api'
import { AdminViewerError } from '../AdminViewerError'
import { useAdminSections } from '../admin-viewer'
import { SettingsPageActions, useSettingsFrame } from '../settings-frame'
import { type MemberSignInsAnswer, MembersPage, memberRoleLabel } from './members-data'
import { InviteMember, type MemberLinkReceipt } from './members-invite'
import { MemberLinkResult } from './members-link-result'
import { MemberPerson } from './members-person'
import { ConfirmInline, EntityRow, Section } from './shared'

const createPage = (pool: import('@podium/client-graph/pool').MobxPool) => new MembersPage(pool)

export const MembersSection = observer(function MembersSection() {
  const origin = serverConfig(window.location).httpOrigin
  const data = useOpeningView(useWorklistPool(), createPage)
  const viewer = useAdminSections()
  const admin = viewer.status === 'ready' && viewer.sections.includes('people')
  const { openTakeover } = useSettingsFrame()
  const reload = useCallback(async () => {
    if (!data || viewer.status !== 'ready') return
    await Promise.all([
      data.read(() =>
        admin
          ? memberRequest<MemberDirectoryAnswer>(origin, 'list')
          : memberRequest<MemberRosterAnswer>(origin, 'directory'),
      ),
      ...(admin
        ? [data.devices.load(() => authRequest<MemberSignInsAnswer>(origin, 'admin/access'))]
        : []),
    ])
  }, [admin, data, origin, viewer.status])
  useEffect(() => {
    if (!data || viewer.status !== 'ready') return
    return followVisibleRequest(
      () => {
        if (!data.loading) void reload()
      },
      {
        visible: () => document.visibilityState !== 'hidden',
        subscribe: (changed) => {
          document.addEventListener('visibilitychange', changed)
          return () => document.removeEventListener('visibilitychange', changed)
        },
      },
    )
  }, [data, reload, viewer.status])

  if (viewer.status === 'error') return <AdminViewerError viewer={viewer} />
  if (!data || viewer.status === 'loading')
    return (
      <p className="settings-prose" role="status">
        Loading members…
      </p>
    )

  return (
    <>
      {admin && (
        <SettingsPageActions>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              openTakeover({
                title: 'Invite someone',
                content: <InviteMember data={data} origin={origin} reload={reload} />,
              })
            }
          >
            <Plus size={14} aria-hidden="true" />
            Invite
          </Button>
        </SettingsPageActions>
      )}
      <Section list>
        {data.error && (
          <div className="settings-list-note">
            <p className="settings-prose text-destructive" role="alert">
              {data.error}
            </p>
            <Button size="sm" variant="ghost" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        )}
        {!data.answer && data.loading && (
          <p className="settings-list-note settings-prose" role="status">
            Loading members…
          </p>
        )}
        {data.members.map((member) => (
          <MemberListRow
            key={member.id}
            member={member}
            data={data}
            admin={admin}
            onOpen={() =>
              openTakeover({
                title: member.displayName,
                content: (
                  <MemberPerson
                    key={member.id}
                    member={member}
                    data={data}
                    origin={origin}
                    reload={reload}
                  />
                ),
              })
            }
          />
        ))}
        {data.answer && !data.members.length && (
          <p className="settings-list-note settings-prose">No members.</p>
        )}
      </Section>
      {admin && (
        <Section title="Pending invites" list>
          {data.invites.length ? (
            data.invites.map((invite) => (
              <PendingInvite
                key={invite.id}
                invite={invite}
                data={data}
                origin={origin}
                reload={reload}
              />
            ))
          ) : (
            <div className="settings-list-note">
              <p className="settings-label">No pending invites</p>
              <p className="settings-prose mt-1">Invite links work once and expire after 7 days.</p>
            </div>
          )}
        </Section>
      )}
    </>
  )
})

const MemberListRow = observer(function MemberListRow({
  member,
  data,
  admin,
  onOpen,
}: {
  member: MemberModel
  data: MembersPage
  admin: boolean
  onOpen: () => void
}) {
  const person = data.person(member)
  return (
    <EntityRow
      leading={person.initials}
      title={member.displayName}
      pills={
        <>
          {person.self && <Badge variant="outline">You</Badge>}
          {admin && member.disabledAt && <Badge variant="destructive">Disabled</Badge>}
        </>
      }
      subtitle={
        admin ? (
          <>
            {member.email || 'No email'} ·{' '}
            {data.devices.error
              ? 'Devices unavailable'
              : !data.devices.answer
                ? 'Loading devices…'
                : `${data.devicesTruncated ? 'At least ' : ''}${person.devices.length} device${person.devices.length === 1 ? '' : 's'} signed in`}
          </>
        ) : undefined
      }
      trailing={<span className="settings-prose">{memberRoleLabel(member.role)}</span>}
      onClick={admin ? onOpen : undefined}
    />
  )
})

type Invite = MemberDirectoryAnswer['invites'][number]
const PendingInvite = observer(function PendingInvite({
  invite,
  data,
  origin,
  reload,
}: {
  invite: Invite
  data: MembersPage
  origin: string
  reload: () => Promise<unknown>
}) {
  const [pending, setPending] = useState<'revoke' | 'replace'>()
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<MemberLinkReceipt>()
  const label = invite.email || 'Shareable link'
  const recovery = Boolean(invite.memberId && data.actionsFor(invite.memberId).includes('recovery'))
  const needsPassword = data.hasOwnCredential && (recovery || invite.role === 'admin')

  const replace = async (current: string) => {
    if (busy) return
    setBusy(true)
    try {
      const result = await memberRequest<{ url: string }>(
        origin,
        recovery ? 'recovery' : 'invite',
        recovery
          ? { id: invite.memberId, current }
          : {
              ...(invite.memberId ? { memberId: invite.memberId } : {}),
              ...(invite.email ? { email: invite.email } : {}),
              role: invite.role,
              current,
              sendEmail: false,
            },
      )
      // Preserve the usable result even if the second request fails.
      setReceipt({ url: result.url, notice: 'New link created. Replacing the old link…' })
      try {
        await memberRequest(origin, 'revoke', { id: invite.id })
      } catch (cause) {
        setReceipt({
          url: result.url,
          notice:
            'New link created, but the old link could not be revoked. Revoke it before sharing this one.',
        })
        throw cause
      }
      // Keep the result in a separate takeover: refreshing removes the old row.
      let notice = 'New link ready. The old link no longer works.'
      try {
        await navigator.clipboard.writeText(result.url)
        notice = 'New link copied. The old link no longer works.'
      } catch {
        /* The result keeps a selectable link and Copy action. */
      }
      openResult(result.url, notice)
      await reload()
    } finally {
      setBusy(false)
    }
  }
  const { openTakeover } = useSettingsFrame()
  const openResult = (url: string, notice: string) =>
    openTakeover({
      title: recovery ? 'Password reset link' : 'Invite link',
      content: (
        <Section title={recovery ? 'Password reset link' : 'Invite link'}>
          <MemberLinkResult
            label={recovery ? 'Password reset link' : 'Invite link'}
            url={url}
            notice={notice}
          />
        </Section>
      ),
    })
  return (
    <div>
      <EntityRow
        leading={<Link size={18} />}
        title={label}
        subtitle={`${memberRoleLabel(invite.role)} · Expires ${new Date(invite.expiresAt).toLocaleDateString()}`}
        trailing={
          <>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPending('replace')}>
              New link
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPending('revoke')}>
              Revoke
            </Button>
          </>
        }
      />
      {pending === 'replace' && (
        <ConfirmInline
          key="replace"
          sentence={`Create a new link for ${label}? The old one stops working.`}
          actionLabel="Create new link"
          hasPassword={needsPassword}
          pending={busy}
          onConfirm={replace}
          onCancel={() => setPending(undefined)}
        />
      )}
      {pending === 'revoke' && (
        <ConfirmInline
          key="revoke"
          sentence={`Revoke the invite for ${label}? The link stops working.`}
          actionLabel="Revoke invite"
          destructive
          pending={busy}
          onConfirm={async () => {
            setBusy(true)
            try {
              await memberRequest(origin, 'revoke', { id: invite.id })
              setPending(undefined)
              toast('Invite revoked')
              await reload()
            } finally {
              setBusy(false)
            }
          }}
          onCancel={() => setPending(undefined)}
        />
      )}
      {receipt && (
        <MemberLinkResult
          key={receipt.url}
          label={recovery ? 'Password reset link' : 'Invite link'}
          {...receipt}
        />
      )}
    </div>
  )
})
