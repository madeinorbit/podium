import { RequestAnswer } from '@podium/client-graph/request-answer'
import { Laptop, Link2, Shield, Smartphone } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { serverConfig } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { authRequest } from '@/features/setup/member-api'
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
  signInsTotal?: number
  signIns: {
    id?: string | null
    memberId: string
    memberName: string
    kind: string
    deviceName: string | null
    platform: string | null
    createdAt: string
    lastSeenAt: string | null
    expiresAt: string
  }[]
}

type SignIn = AccessAnswer['signIns'][number]
const KIND_LABEL: Record<string, string> = {
  login: 'Browser or desktop',
  mobile: 'Phone',
  upstream: 'Upstream link',
  'break-glass': 'Host recovery',
}
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'Not seen yet')
export const isAdvancedSignIn = (signIn: Pick<SignIn, 'kind'>) =>
  signIn.kind === 'upstream' || signIn.kind === 'break-glass'
export function filterSignIns(
  signIns: SignIn[],
  filter: 'everyone' | 'phones' | 'advanced',
): SignIn[] {
  return signIns.filter((signIn) =>
    filter === 'advanced'
      ? isAdvancedSignIn(signIn)
      : !isAdvancedSignIn(signIn) && (filter === 'everyone' || signIn.kind === 'mobile'),
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
  if (network.answer.mode === 'daemon' || network.answer.mode === 'client')
    return <NetworkSection view={network} />
  return <HostAccess network={network} />
})

const HostAccess = observer(function HostAccess({ network }: { network: NetworkSettingsView }) {
  const trpc = useSettingsTrpc()
  const answer = useMemo(() => new RequestAnswer<AccessAnswer>(), [])
  const origin = serverConfig(window.location).httpOrigin
  const reload = useCallback(
    () => answer.load(() => authRequest<AccessAnswer>(origin, 'admin/access')),
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
  const total = data?.signInsTotal ?? data?.signIns.length ?? 0
  const visible = filterSignIns(data?.signIns ?? [], filter)
  const advanced = filterSignIns(data?.signIns ?? [], 'advanced')
  const signInRow = (signIn: SignIn) => (
    <SignInRow
      key={signIn.id ?? `${signIn.memberId}-${signIn.kind}-${signIn.createdAt}-${signIn.expiresAt}`}
      signIn={signIn}
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
        <InstanceLoginSection trpc={trpc} onChanged={() => void reload()} />
      </SettingsPageSection>
      <SettingsPageSection id="access">
        <Section
          list
          title="Signed in now"
          hint="Every sign-in that has not expired. Ending one signs that device out at once."
          action={
            <fieldset aria-label="Filter sign-ins" className="settings-segmented">
              {(['everyone', 'phones'] as const).map((value) => (
                <Button
                  key={value}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={filter === value}
                  className={
                    filter === value ? 'bg-secondary text-foreground' : 'text-muted-foreground'
                  }
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
                {filter === 'phones' && ` ${visible.length} phones in this list.`} Upstream links
                and host recovery sign-ins are listed under Advanced.
              </p>
            </>
          )}
        </Section>
      </SettingsPageSection>
      <SettingsPageSection id="access-advanced">
        <Section title="Advanced" hint="Set by this deployment’s configuration.">
          <AdvancedNetworkRows view={network} />
          <Row
            label="Server-to-server links"
            readOnly
            readOnlyValue={
              data
                ? `${advanced.filter((signIn) => signIn.kind === 'upstream').length} upstream links`
                : 'Loading…'
            }
          />
          {advanced.map(signInRow)}
        </Section>
      </SettingsPageSection>
    </>
  )
})

function SignInRow({
  signIn,
  revoking,
  error,
  onRevoke,
}: {
  signIn: SignIn
  revoking: string | null
  error?: string
  onRevoke: (id: string) => Promise<void>
}) {
  const Icon =
    signIn.kind === 'mobile'
      ? Smartphone
      : signIn.kind === 'upstream'
        ? Link2
        : signIn.kind === 'break-glass'
          ? Shield
          : Laptop
  const device = signIn.deviceName ?? KIND_LABEL[signIn.kind] ?? signIn.kind
  return (
    <EntityRow
      leading={<Icon size={18} aria-hidden="true" />}
      title={signIn.memberName}
      subtitle={
        <>
          <span>
            {device}
            {signIn.platform ? ` · ${signIn.platform}` : ''}
          </span>
          <span className="mt-1 block">
            Signed in {day(signIn.createdAt)} · Last seen {day(signIn.lastSeenAt)}
          </span>
          <span className="settings-micro mt-1 block">Expires {day(signIn.expiresAt)}</span>
          {error && (
            <span className="mt-1 block text-destructive" role="alert">
              {error}
            </span>
          )}
        </>
      }
      trailing={
        signIn.id ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Sign out ${signIn.memberName}’s ${device}`}
            disabled={revoking !== null}
            pending={revoking === signIn.id}
            pendingLabel="Signing out…"
            onClick={() => {
              if (signIn.id) void onRevoke(signIn.id)
            }}
          >
            Sign out
          </Button>
        ) : (
          <span
            className="settings-micro text-muted-foreground"
            title="This older sign-in has no public ID. Use Sign out everywhere in Members."
          >
            Use Members
          </span>
        )
      }
    />
  )
}
