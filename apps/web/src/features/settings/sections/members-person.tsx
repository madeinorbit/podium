import { memberRoster, type MemberRosterAnswer } from '@podium/client-graph/member-roster'
import type { MemberModel } from '@podium/client-graph/requested-models'
import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { Button } from '@/components/ui/button'
import { authRequest, memberRequest } from '@/features/setup/member-api'
import { useSettingsFrame } from '../settings-frame'
import { useSettingsTrpc } from '../stable-access'
import { KeySharing, StoredKeys } from './key-sharing'
import { deviceLabel, memberRoleLabel, type MembersPage, type SettingsPerson } from './members-data'
import { MemberLinkResult } from './members-link-result'
import { MemberRoleControl } from './members-role'
import { ConfirmInline, providerLabel, Row, Section } from './shared'

type AccessAction = 'disable' | 'enable' | 'recovery' | 'invite' | 'remove'
const ACCESS = {
  recovery: {
    label: 'Send a password reset link',
    description: 'A one-time link, valid 24 hours. Using it signs them out everywhere.',
    button: 'Create link…', confirm: 'Create password reset link',
    sentence: (member: MemberModel) => `Create a link that sets a new password for ${member.displayName}? Using it signs them out everywhere.`,
  },
  invite: {
    label: 'Send new sign-in link',
    description: 'For someone who has not finished setting up their sign-in. The link works once and expires in 7 days.',
    button: 'Create link…', confirm: 'Create sign-in link',
    sentence: (member: MemberModel) => `Create a new sign-in link for ${member.displayName}?`,
  },
  disable: {
    label: 'Disable',
    description: 'Signs them out and blocks sign-in. Everything they made is kept.',
    button: 'Disable…', confirm: 'Confirm disable',
    sentence: (member: MemberModel) => `Disable ${member.displayName}? They are signed out and cannot sign in or act. Their history and the shares on their machines are kept.`,
  },
  enable: {
    label: 'Enable', description: 'They can sign in again.',
    button: 'Enable…', confirm: 'Confirm enable',
    sentence: (member: MemberModel) => `Enable ${member.displayName}? They can sign in again.`,
  },
  remove: {
    label: 'Remove from workspace',
    description: 'Their tasks and sessions stay. Machines they look after need a new owner.',
    button: 'Remove…', confirm: 'Confirm removal',
    sentence: (member: MemberModel) => `Remove ${member.displayName}? They will lose access. Their tasks and sessions will be kept.`,
  },
} as const

export const MemberPerson = observer(function MemberPerson({ data, member, origin, reload }: {
  data: MembersPage
  member: MemberModel
  origin: string
  reload: () => Promise<unknown>
}) {
  const { closeTakeover } = useSettingsFrame()
  const person = data.person(member)
  const [pending, setPending] = useState<AccessAction | 'setRole' | 'signOutEverywhere'>()
  const [role, setRole] = useState<'member' | 'admin'>()
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState<{ action: 'recovery' | 'invite'; url: string }>()
  const select = (action: typeof pending) => {
    setPending(action)
    setRole(undefined)
  }

  const apply = async (action: NonNullable<typeof pending>, current: string) => {
    if (busy || !person.allows(action)) return
    setBusy(true)
    try {
      const route = action === 'setRole' ? 'role' : action === 'signOutEverywhere' ? 'sign-out-everywhere' : action
      const body = action === 'setRole' ? { id: member.id, role, current }
        : action === 'signOutEverywhere' ? { id: member.id }
        : action === 'invite' ? { memberId: member.id, role: member.role, current, sendEmail: false }
        : { id: member.id, current }
      const result = await memberRequest<{ url?: string }>(origin, route, body)
      if (result.url && (action === 'recovery' || action === 'invite')) setLink({ action, url: result.url })
      setPending(undefined)
      setRole(undefined)
      if (action === 'remove') closeTakeover()
      else if (action !== 'recovery' && action !== 'invite') toast(action === 'setRole' ? 'Role changed' : action === 'signOutEverywhere' ? 'Signed out everywhere' : action === 'disable' ? 'Member disabled' : 'Member enabled')
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const confirm = (action: NonNullable<typeof pending>, sentence: string, actionLabel: string, destructive = false, password = true) =>
    pending === action && person.allows(action) ? <ConfirmInline
      key={action} sentence={sentence} actionLabel={actionLabel} hasPassword={password && data.hasOwnCredential}
      destructive={destructive} pending={busy} onConfirm={(current) => apply(action, current)}
      onCancel={() => { setPending(undefined); setRole(undefined) }}
    /> : null

  return <>
    <Section title="Profile">
      <Row label="Email" readOnly readOnlyValue={member.email || 'No email'} />
      <div>
        <Row label="Role" pending={busy}
          description={person.self ? 'You can’t change your own role.' : (role || member.role) === 'admin' ? 'Manages members, machines and workspace settings. Cannot open anyone’s sessions.' : 'Uses the workspace; an admin manages its settings.'}
          readOnly={!person.allows('setRole')} readOnlyValue={memberRoleLabel(member.role)}>
          <MemberRoleControl value={pending === 'setRole' ? role || member.role : member.role}
            onChange={(next) => { setRole(next); setPending(next === member.role ? undefined : 'setRole') }} disabled={busy} />
        </Row>
        {confirm('setRole', role === 'admin' ? `Make ${member.displayName} an admin? They will manage members, machines and workspace settings, but cannot open anyone’s sessions.` : `Make ${member.displayName} a member? They will no longer manage this workspace.`, 'Change role')}
      </div>
      {member.disabledAt && <p className="settings-list-note settings-prose">Disabled. They cannot sign in.</p>}
    </Section>
    <PersonDevices person={person} data={data} origin={origin} reload={reload}
      onSignOutEverywhere={() => select('signOutEverywhere')}>
      {confirm('signOutEverywhere', `Sign ${member.displayName} out on every device? They can sign in again.`, 'Confirm sign out', true, false)}
    </PersonDevices>
    <PersonKeys member={member} origin={origin} />
    <Section title="Machines they look after">
      {person.machines.length ? person.machines.map((machine) =>
        <Row key={machine.id} label={machine.name} readOnly readOnlyValue={machine.online ? 'Online' : 'Offline'} />
      ) : <p className="settings-list-note settings-prose">None.</p>}
    </Section>
    {!person.self && <Section title="Access">
      {(['recovery', 'invite', 'disable', 'enable', 'remove'] as const).filter((action) => person.allows(action)).map((action) => {
        const config = ACCESS[action]
        const lostMachines = action === 'remove' && person.machines.length ? ` These machines will lose their owner: ${person.machines.map((machine) => machine.name).join(', ')}.` : ''
        return <div key={action}>
          <Row label={config.label} description={config.description} pending={busy}>
            <Button type="button" size="sm" variant={action === 'remove' ? 'destructive' : 'outline'}
              disabled={busy} onClick={() => select(action)}>{config.button}</Button>
          </Row>
          {confirm(action, config.sentence(member) + lostMachines, config.confirm, action === 'remove' || action === 'disable', action !== 'invite' || member.role === 'admin')}
          {link?.action === action && <MemberLinkResult key={link.url} label={action === 'recovery' ? 'Password reset link' : 'Sign-in link'}
            url={link.url} notice={action === 'recovery' ? 'Password reset link ready. It sets a new password once, within 24 hours.' : 'Sign-in link ready. It works once and expires in 7 days.'} />}
        </div>
      })}
    </Section>}
  </>
})

const PersonDevices = observer(function PersonDevices({ person, data, origin, reload, onSignOutEverywhere, children }: {
  person: SettingsPerson
  data: MembersPage
  origin: string
  reload: () => Promise<unknown>
  onSignOutEverywhere: () => void
  children: React.ReactNode
}) {
  const [revoking, setRevoking] = useState<string>()
  const [error, setError] = useState<{ id: string; message: string }>()
  const revoke = async (id: string) => {
    if (revoking) return
    setRevoking(id)
    setError(undefined)
    try {
      await authRequest(origin, 'admin/sign-ins/revoke', { id })
      await reload()
      toast('Device signed out')
    } catch (cause) {
      setError({ id, message: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setRevoking(undefined)
    }
  }
  return <Section title="Devices" hint={person.self ? 'Manage your own devices and sign out in Account.' : undefined}>
    {data.devices.error ? <p className="settings-list-note settings-prose text-destructive" role="alert">{data.devices.error}</p>
      : !data.devices.answer ? <p className="settings-list-note settings-prose" role="status">Loading devices…</p>
      : <>
        {data.devicesTruncated && <p className="settings-list-note settings-prose">Showing devices from the latest {data.devices.answer.signIns.length} of {data.devices.answer.signInsTotal} workspace sign-ins. This list may be incomplete.</p>}
        {person.devices.length ? person.devices.map((device) => <div key={device.id || `${device.kind}-${device.createdAt}-${device.expiresAt}`}>
          <Row label={deviceLabel(device)}
            description={`${device.platform ? `${device.platform} · ` : ''}Last seen ${device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : 'unknown'}`}
            error={error?.id === device.id ? error.message : undefined}>
            {!person.self && person.allows('signOutEverywhere') && device.id && <Button type="button" size="sm" variant="ghost" disabled={Boolean(revoking)}
              pending={revoking === device.id} pendingLabel="Signing out…" aria-label={`Sign out ${deviceLabel(device)}`}
              onClick={() => void revoke(device.id!)}>Sign out</Button>}
          </Row>
        </div>) : <p className="settings-list-note settings-prose">{data.devicesTruncated ? 'No devices in this portion of the sign-in list.' : 'Not signed in anywhere.'}</p>}
        {!person.self && person.allows('signOutEverywhere') && (person.devices.length > 0 || data.devicesTruncated) && <div>
          <Row label="Sign out everywhere" description="Ends all their sign-ins. They can sign in again.">
            <Button variant="ghost" size="sm" onClick={onSignOutEverywhere}>Sign out everywhere</Button>
          </Row>
          {children}
        </div>}
      </>}
  </Section>
})

const PersonKeys = observer(function PersonKeys({ member, origin }: { member: MemberModel; origin: string }) {
  const trpc = useSettingsTrpc()
  const pool = useWorklistPool()
  const directory = useMemo(() => pool ? memberRoster(pool) : null, [pool])
  const [keys] = useState(() => new StoredKeys())
  const reload = useCallback(() => keys.load(() => trpc.accounts.keys.query({})), [keys, trpc])
  useEffect(() => {
    void reload()
    if (directory && !directory.answer) void directory.read(() => memberRequest<MemberRosterAnswer>(origin, 'directory'))
    return () => keys.dispose()
  }, [directory, keys, origin, reload])
  const own = (keys.answer ?? []).filter((key) => key.owner === member.id)
  return <Section title="Their API keys" hint="You can change who may use a key, never see it.">
    {keys.error ? <p className="settings-list-note settings-prose text-destructive" role="alert">{keys.error}</p>
      : !keys.answer ? <p className="settings-list-note settings-prose" role="status">Loading keys…</p>
      : own.length ? own.map((key) => {
        const label = key.id === 'managed:claude-oauth' ? 'Claude subscription (setup-token)' : `${providerLabel(key.provider as Parameters<typeof providerLabel>[0])} API key`
        return <div key={key.id} className="settings-list-row">
          <Row label={label} readOnly readOnlyValue={key.identity || 'Stored'} />
          <KeySharing accountId={key.id} label={`${member.displayName}’s ${label}`}
            sharing={key.sharing} owner={key.owner} directory={directory}
            currentMemberId={directory?.currentMemberId} onChanged={() => void reload()} />
        </div>
      }) : <p className="settings-list-note settings-prose">No keys stored.</p>}
  </Section>
})
