import { type AuthCapabilities, accountPageUrl } from '@podium/client-core/accounts'
import { relativeTime } from '@podium/client-core/focus'
import { RequestAnswer } from '@podium/client-graph/request-answer'
import type { DeviceSignInView } from '@podium/protocol'
import { Laptop, Shield, Smartphone } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { serverConfig } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { authRequest } from '@/features/setup/member-api'
import { useClock } from '@/lib/clock-hooks'
import { AdminViewerError } from '../AdminViewerError'
import { useAdminSections } from '../admin-viewer'
import { NetworkSettingsView } from '../network-view'
import { SettingsPageSection } from '../settings-anchors'
import { useSettingsTrpc } from '../stable-access'
import { InstanceLoginSection } from './instance-login'
import { AdvancedNetworkRows, NetworkSection } from './network'
import { EntityRow, Row, Section } from './shared'

/** `/auth/admin/access`: a bounded request answer, never a second member profile. */
export interface AccessAnswer {
  admission: {
    mode: 'invitation'
    signInRequired: boolean
    openInvites: number
    expiredInvites: number
    activeMembers: number
    disabledMembers: number
  }
}

/** `/auth/admin/sign-ins`: the workspace's device sign-ins, each with its member. */
interface AccessSignIns {
  signIns: SignIn[]
  signInsTotal: number
}

type SignIn = DeviceSignInView & { memberId: string; memberName: string }
/** Exact times stay one hover away; the row reads in relative time, as the design does. */
const exact = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never')
/** Host recovery sign-ins are made on the server machine itself, not by a person's device. */
export const isAdvancedSignIn = (signIn: Pick<SignIn, 'kind'>) => signIn.kind === 'host'
export function filterSignIns(
  signIns: SignIn[],
  filter: 'everyone' | 'phones' | 'advanced',
): SignIn[] {
  return signIns.filter((signIn) =>
    filter === 'advanced'
      ? isAdvancedSignIn(signIn)
      : !isAdvancedSignIn(signIn) && (filter === 'everyone' || signIn.kind === 'phone'),
  )
}

/** Admin-only, including direct renders outside the settings rail. */
export function AccessSection(): JSX.Element | null {
  const viewer = useAdminSections()
  if (viewer.status === 'error') return <AdminViewerError viewer={viewer} />
  if (viewer.status === 'loading')
    return (
      <p className="settings-prose" role="status">
        Checking administrator access…
      </p>
    )
  if (!viewer.sections.includes('access')) return null
  return <AccessPage />
}

const AccessPage = observer(function AccessPage() {
  const trpc = useSettingsTrpc()
  const network = useMemo(() => new NetworkSettingsView(trpc), [trpc])
  useEffect(() => {
    network.open()
    return () => network.close()
  }, [network])
  if (!network.answer)
    return (
      <Section title="Address">
        {network.error ? (
          <>
            <p className="settings-prose text-destructive" role="alert">
              Couldn’t load the workspace address.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void network.refresh(true)}
            >
              Try again
            </Button>
          </>
        ) : (
          <p role="status" className="settings-prose">
            Loading access settings…
          </p>
        )}
      </Section>
    )
  if (network.hostInfo?.mode === 'daemon' || network.hostInfo?.mode === 'client')
    return <NetworkSection view={network} />
  return <HostAccess network={network} />
})

const HostAccess = observer(function HostAccess({ network }: { network: NetworkSettingsView }) {
  const trpc = useSettingsTrpc()
  const answer = useMemo(
    () => new RequestAnswer<AccessAnswer & AccessSignIns & { capabilities: AuthCapabilities }>(),
    [],
  )
  const origin = serverConfig(window.location).httpOrigin
  const reload = useCallback(
    () =>
      answer.load(async () => {
        const [access, signIns, status] = await Promise.all([
          authRequest<AccessAnswer>(origin, 'admin/access'),
          authRequest<AccessSignIns>(origin, 'admin/sign-ins'),
          authRequest<{ capabilities: AuthCapabilities }>(origin, 'status'),
        ])
        return { ...access, ...signIns, capabilities: status.capabilities }
      }),
    [answer, origin],
  )
  useEffect(() => {
    void reload()
    return () => answer.close()
  }, [answer, reload])
  const [filter, setFilter] = useState<'everyone' | 'phones'>('everyone')
  const [revoking, setRevoking] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<{ id: string; message: string } | null>(null)
  const revokingRef = useRef(false)
  const revoke = async (id: string) => {
    if (revokingRef.current) return
    revokingRef.current = true
    setRevoking(id)
    setRevokeError(null)
    try {
      await authRequest(origin, 'admin/sign-ins/revoke', { id })
      await reload()
    } catch (cause) {
      setRevokeError({
        id,
        message: cause instanceof Error ? cause.message : 'Couldn’t sign out this device.',
      })
    } finally {
      revokingRef.current = false
      setRevoking(null)
    }
  }
  const data = answer.answer
  const total = data?.signInsTotal ?? 0
  const visible = filterSignIns(data?.signIns ?? [], filter)
  const advanced = filterSignIns(data?.signIns ?? [], 'advanced')
  const signInRow = (signIn: SignIn) => (
    <SignInRow
      key={signIn.id}
      signIn={signIn}
      canRevoke={data?.capabilities?.adminEndDeviceSignIn === true}
      revoking={revoking}
      error={revokeError && revokeError.id === signIn.id ? revokeError.message : undefined}
      onRevoke={revoke}
    />
  )
  return (
    <>
      <SettingsPageSection id="network">
        <NetworkSection view={network} />
      </SettingsPageSection>
      <SettingsPageSection id="instance-login">
        <InstanceLoginSection
          trpc={trpc}
          capabilities={data?.capabilities}
          onChanged={() => void reload()}
        />
      </SettingsPageSection>
      <SettingsPageSection id="access">
        <Section
          list
          title="Signed in now"
          hint={
            data?.capabilities?.adminEndDeviceSignIn
              ? 'Every sign-in that has not expired. Ending one signs that device out at once.'
              : 'Every sign-in that has not expired.'
          }
          action={
            <fieldset aria-label="Filter sign-ins" className="settings-segmented">
              {(['everyone', 'phones'] as const).map((value) => (
                <Button
                  key={value}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {value === 'everyone' ? 'Everyone' : 'Phones'}
                </Button>
              ))}
            </fieldset>
          }
        >
          {answer.error && (
            <div className="settings-list-note">
              <p role="alert" className="settings-prose text-destructive">
                Couldn’t refresh sign-ins. {answer.error}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
                Try again
              </Button>
            </div>
          )}
          {!data ? (
            !answer.error && (
              <p role="status" className="settings-list-note settings-prose">
                Loading sign-ins…
              </p>
            )
          ) : (
            <>
              {visible.length ? (
                visible.map(signInRow)
              ) : (
                <p className="settings-list-note settings-prose">
                  {filter === 'phones'
                    ? 'No phones are signed in in this list.'
                    : 'No browsers, desktops or phones are signed in in this list.'}
                </p>
              )}
              <p className="settings-list-note settings-prose">
                Showing {data.signIns.length} of {total} sign-ins
                {total > data.signIns.length ? ', latest expiry first' : ''}.
                {filter === 'phones' && ` ${visible.length} phones in this list.`} Host recovery
                sign-ins are listed under Advanced.
              </p>
            </>
          )}
        </Section>
      </SettingsPageSection>
      <SettingsPageSection id="access-advanced">
        <Section title="Advanced" hint="Set by this deployment’s configuration.">
          <AdvancedNetworkRows view={network} />
          {data?.capabilities?.organisations && data.capabilities.accountUrl && (
            <Row
              label="Organisations"
              description="Manage organisations and workspaces in your account."
            >
              <a className="underline" href={accountPageUrl(data.capabilities, 'workspaces')}>
                Manage organisations
              </a>
            </Row>
          )}
          {advanced.map(signInRow)}
        </Section>
      </SettingsPageSection>
    </>
  )
})

/** One icon per kind of sign-in, shared by Access and a member's Devices. */
export function SignInIcon({ kind }: { kind: string }): JSX.Element {
  const Icon = kind === 'phone' ? Smartphone : kind === 'host' ? Shield : Laptop
  return <Icon size={18} aria-hidden="true" />
}

const KIND_LABEL: Record<SignIn['kind'], string> = {
  browser: 'Browser',
  desktop: 'Desktop',
  phone: 'Phone',
  host: 'Host recovery',
}

function SignInRow({
  signIn,
  canRevoke,
  revoking,
  error,
  onRevoke,
}: {
  signIn: SignIn
  canRevoke: boolean
  revoking: string | null
  error?: string
  onRevoke: (id: string) => Promise<void>
}) {
  const device = signIn.deviceName || KIND_LABEL[signIn.kind]
  const now = useClock(30_000)
  return (
    <EntityRow
      leading={<SignInIcon kind={signIn.kind} />}
      title={signIn.memberName}
      pills={
        <span className="settings-micro min-w-0 max-w-full break-words">
          {device}
          {signIn.platform ? ` · ${signIn.platform}` : ''}
        </span>
      }
      subtitle={
        <>
          {/* One line, as the design has it: the subtitle is a flex row, so
              stacked blocks inside it landed at different heights. */}
          <span
            title={`Signed in ${exact(signIn.createdAt)} · Last seen ${exact(signIn.lastSeenAt)} · Expires ${exact(signIn.expiresAt)}`}
          >
            Signed in {relativeTime(signIn.createdAt, now)} · last seen{' '}
            {signIn.lastSeenAt ? relativeTime(signIn.lastSeenAt, now) : 'not yet'}
          </span>
          {error && (
            <span className="basis-full text-destructive" role="alert">
              {error}
            </span>
          )}
        </>
      }
      trailing={
        canRevoke ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Sign out ${signIn.memberName}’s ${device}`}
            disabled={revoking !== null}
            pending={revoking === signIn.id}
            pendingLabel="Signing out…"
            onClick={() => void onRevoke(signIn.id)}
          >
            Sign out
          </Button>
        ) : undefined
      }
    />
  )
}
