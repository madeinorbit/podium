import { relativeTime } from '@podium/client-core/focus'
import type { RecordRequest } from '@podium/client-graph/requested-records'
import { lazy } from '@podium/mobx-helpers'
import {
  MobileClientSession as MobileClientSessionSchema,
  type MobilePairStartResponse as MobilePairStart,
  MobilePairStartResponse,
  type MobilePairStatusResponse as MobilePairStatus,
  MobilePairStatusResponse,
  type MobileClientSession as MobileSessionView,
  RevokeMobileClientSessionRequest,
} from '@podium/protocol'
import {
  ArrowRight,
  CheckCircle2,
  Copy,
  ExternalLink,
  Globe,
  LogOut,
  Monitor,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  TriangleAlert,
} from 'lucide-react'
import { compareShallow } from 'mobx'
import { observer } from 'mobx-react-lite'
import { QRCodeSVG } from 'qrcode.react'
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { serverConfig } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { memberRequest } from '@/features/setup/member-api'
import { useAccount } from '@/lib/account-context'
import { useAgeNow, useCountdown, useDeadlineNow } from '@/lib/clock-hooks'
import { WorkingMark } from '@/lib/motion/WorkingMark'
import { workspaceFetch } from '@/lib/workspace-request'
import { useSettingsUnsyncedChangeCount } from '../readers'
import { deviceKey, useSettingsRecords } from '../record-readers'
import { useSettingsRowId } from '../settings-anchors'
import { ConfirmInline, ThisDeviceTag } from './shared'

/**
 * Narrow view of the server contract consumed by this screen. Keeping it here
 * makes the security boundary visible: the web UI receives an ephemeral
 * envelope, a safe pairing handle, and public session metadata — never a
 * durable credential. The opaque per-row sessionId is used only for revocation.
 */
export interface MobilePairingApi {
  auth: {
    mobilePairingStart: {
      mutate(): Promise<MobilePairStart>
    }
    mobilePairingStatus: {
      query(input: { pairingId: string }): Promise<MobilePairStatus>
    }
    mobilePairingApprove: {
      mutate(input: { pairingId: string }): Promise<unknown>
    }
    mobilePairingDeny: {
      mutate(input: { pairingId: string }): Promise<unknown>
    }
    mobileSessions: {
      query(): Promise<MobileSessionView[]>
    }
    revokeMobileSession: {
      mutate(input: { sessionId: string }): Promise<unknown>
    }
  }
}

type PairStage =
  | { kind: 'waiting' }
  | ({ kind: 'claimed' } & Pick<
      Extract<MobilePairStatus, { state: 'claimed' }>,
      'deviceName' | 'platform' | 'phrase'
    >)
  | { kind: 'approved' }
  | { kind: 'denied' }
  | { kind: 'cancelled' }
  | { kind: 'expired' }
  | { kind: 'unavailable' }

type PairStartView = Pick<Extract<MobilePairStart, { mode: 'pair' }>, 'pairingId' | 'expiresAt'>

type PairingFlow =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | {
      kind: 'pair'
      start: PairStartView
      url: string
      stage: PairStage
    }
  | {
      kind: 'open'
      url: string
    }
  | { kind: 'error'; reason: StartFailure }

type StartFailure = 'public-url' | 'transport' | 'auth' | 'unavailable' | 'invalid-response'

const SAFE_START_ERRORS: Record<StartFailure, string> = {
  'public-url': 'Set the address this phone can reach before pairing. Add it in Access settings.',
  transport:
    'Phone pairing works only over trusted HTTPS. Choose Tailscale Serve or add an HTTPS reverse proxy in Access settings.',
  auth: 'Your sign-in is no longer authorized. Sign in again, then create a new code.',
  unavailable: 'Couldn’t reach this server. Check the connection and try again.',
  'invalid-response':
    'This server returned an unexpected pairing response. Update or restart Podium, then try again.',
}
const SAFE_ACTION_ERROR = 'Couldn’t update this pairing request. Create a new code and try again.'
const SAFE_CANCEL_ERROR =
  'Couldn’t cancel this request. Keep the link private; it will expire automatically.'
const SAFE_REVOKE_ERROR = 'Couldn’t sign out this device. Try again.'

const BLOCKED_START_TITLES: Record<'public-url' | 'transport', string> = {
  'public-url': 'Podium URL needed',
  transport: 'Secure connection needed',
}

/** Open mode has no credential ceremony: its QR is exactly this URL. */
export function mobileServerUrl(canonicalOrigin: string): string {
  const url = new URL('/mobile', canonicalOrigin)
  url.hash = ''
  url.search = ''
  return url.href
}

function canonicalOrigin(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('invalid canonical origin')
  }
  if (url.origin !== value) throw new Error('non-canonical origin')
  return url.origin
}

function pairUrl(result: Extract<MobilePairStart, { mode: 'pair' }>): string {
  const origin = canonicalOrigin(result.canonicalOrigin)
  const url = new URL(result.pairingUrl)
  if (
    url.username ||
    url.password ||
    url.pathname !== '/mobile' ||
    url.search ||
    url.hash !== `#pair=${result.envelope}` ||
    url.protocol !== 'https:' ||
    url.origin !== origin
  ) {
    throw new Error('invalid pairing URL')
  }
  return url.href
}

class MobilePairingHttpError extends Error {
  constructor(readonly status: number) {
    super(`mobile pairing request refused (${status})`)
  }
}

class MobilePairingNetworkError extends Error {}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new MobilePairingHttpError(response.status)
  return response.json()
}

async function requestJson(input: string, init: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await workspaceFetch(input, init)
  } catch {
    throw new MobilePairingNetworkError()
  }
  return readJson(response)
}

function startFailure(error: unknown): StartFailure {
  if (error instanceof MobilePairingHttpError) {
    if (error.status === 409) return 'public-url'
    if (error.status === 400) return 'transport'
    if (error.status === 401 || error.status === 403) return 'auth'
    return 'unavailable'
  }
  if (error instanceof MobilePairingNetworkError) return 'unavailable'
  return 'invalid-response'
}

/**
 * This transport deliberately does not use reportingFetch: a pairing URL
 * contains a bearer secret in its fragment and this boundary must never grow
 * ordinary request/error logging or offline retry behavior.
 */
export function createMobilePairingApi(httpOrigin: string): MobilePairingApi {
  const post = (path: string, body: unknown): Promise<unknown> =>
    requestJson(`${httpOrigin}${path}`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      referrerPolicy: 'no-referrer',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  return {
    auth: {
      mobilePairingStart: {
        mutate: async () =>
          MobilePairStartResponse.parse(await post('/auth/mobile-pair/start', {})),
      },
      mobilePairingStatus: {
        query: async (input) =>
          MobilePairStatusResponse.parse(await post('/auth/mobile-pair/status', input)),
      },
      mobilePairingApprove: { mutate: (input) => post('/auth/mobile-pair/approve', input) },
      mobilePairingDeny: { mutate: (input) => post('/auth/mobile-pair/deny', input) },
      mobileSessions: {
        query: async () => {
          // Every sign-in of the caller, not only phones (POD-6701).
          const response = await requestJson(`${httpOrigin}/auth/client-sessions?include=all`, {
            cache: 'no-store',
            credentials: 'include',
            referrerPolicy: 'no-referrer',
            headers: { accept: 'application/json' },
          })
          return MobileClientSessionSchema.array()
            .parse((response as { sessions?: unknown }).sessions)
            .filter(
              (session) =>
                RevokeMobileClientSessionRequest.safeParse({ sessionId: session.sessionId })
                  .success,
            )
        },
      },
      revokeMobileSession: {
        mutate: (input) => post('/auth/client-sessions/revoke', input),
      },
    },
  }
}

function displayPlatform(session: Pick<MobileSessionView, 'kind' | 'platform'>): string {
  const normalized = session.platform.trim().toLowerCase()
  const os =
    normalized === 'ios'
      ? 'iOS'
      : normalized === 'android'
        ? 'Android'
        : normalized === 'macos'
          ? 'macOS'
          : normalized === 'windows'
            ? 'Windows'
            : normalized === 'linux'
              ? 'Linux'
              : normalized === 'web'
                ? 'Web'
                : undefined
  const kind =
    session.kind === 'desktop' ? 'Desktop app' : session.kind === 'browser' ? 'Browser' : 'Phone'
  return os ? `${kind} · ${os}` : kind
}

function DeviceIcon({ kind }: { kind: MobileSessionView['kind'] }): JSX.Element {
  const Icon = kind === 'desktop' ? Monitor : kind === 'browser' ? Globe : Smartphone
  return <Icon className="mt-0.5 size-4 flex-none text-muted-foreground" aria-hidden="true" />
}

function formatActivity(value: string | null, now: number): string {
  if (!value) return 'No activity yet'
  return relativeTime(value, now)
}

function PairingExpiry({ expiresAt }: { expiresAt: string }): JSX.Element {
  const remaining = useCountdown(Date.parse(expiresAt))
  return (
    <p className="settings-micro mt-2 font-mono tabular-nums">
      Expires in {Math.ceil(remaining / 1000)}s
    </p>
  )
}

function PairingCode({
  url,
  mode,
  expiresAt,
  cancelling,
  cancelError,
  onCancel,
}: {
  url: string
  mode: 'pair' | 'open'
  expiresAt?: string
  cancelling?: boolean
  cancelError?: string | null
  onCancel?: () => void
}): JSX.Element {
  const [feedback, setFeedback] = useState<string | null>(null)

  const copy = async (): Promise<void> => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(url)
      setFeedback(
        mode === 'pair'
          ? 'Temporary pairing secret copied. Anyone with it can request access until it expires.'
          : 'Mobile link copied.',
      )
    } catch {
      setFeedback('Couldn’t copy the link. Use Open on this device instead.')
    }
  }

  const open = (): void => {
    window.open(url, '_blank', 'noopener,noreferrer')
    setFeedback('Opened the mobile page in a new tab.')
  }

  return (
    <div className="grid gap-5 sm:grid-cols-[216px_minmax(0,1fr)] sm:items-center">
      <div
        role="img"
        aria-label={mode === 'pair' ? 'Phone pairing QR code' : 'Mobile server URL QR code'}
        className="mx-auto flex size-[216px] items-center justify-center rounded-lg bg-white p-2 ring-1 ring-black/10 sm:mx-0"
      >
        <QRCodeSVG
          value={url}
          size={200}
          level="M"
          marginSize={1}
          bgColor="#ffffff"
          fgColor="#16171a"
          aria-hidden="true"
        />
      </div>
      <div className="min-w-0">
        <p className="settings-label">
          {mode === 'pair' ? 'Scan with the Podium app' : 'Scan with your phone'}
        </p>
        <p className="settings-prose mt-1.5">
          {mode === 'pair'
            ? 'The code creates one visible connection request. It does not contain a signed-in session.'
            : 'This server runs without login. The code contains only its mobile URL; there is no approval step.'}
        </p>
        {mode === 'pair' && (
          <p className="settings-micro mt-2 text-warning">
            This temporary link is a secret. Share it only with the phone you are pairing.
          </p>
        )}
        {expiresAt && <PairingExpiry expiresAt={expiresAt} />}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => void copy()}>
            <Copy aria-hidden="true" />
            Copy link
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={open}>
            <ExternalLink aria-hidden="true" />
            Open on this device
          </Button>
          {mode === 'pair' && onCancel && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              pending={cancelling}
              pendingLabel="Cancelling…"
              onClick={onCancel}
            >
              Cancel code
            </Button>
          )}
        </div>
        {feedback && (
          <p className="settings-micro mt-2" role="status">
            {feedback}
          </p>
        )}
        {cancelError && (
          <p className="settings-prose mt-2 text-destructive" role="alert">
            {cancelError}
          </p>
        )}
      </div>
    </div>
  )
}

function PairingSetupRequired({
  reason,
  onOpenAccess,
}: {
  reason: 'public-url' | 'transport'
  onOpenAccess?: () => void
}): JSX.Element {
  return (
    <div role="alert" className="mt-4 rounded-lg border border-warning/30 bg-warning/5 p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-8 flex-none items-center justify-center rounded-md bg-warning/10 text-warning">
          <ShieldAlert aria-hidden="true" className="size-4" strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <p className="settings-label text-foreground">{BLOCKED_START_TITLES[reason]}</p>
          <p className="settings-prose mt-1 max-w-[58ch]">{SAFE_START_ERRORS[reason]}</p>
          {onOpenAccess && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={onOpenAccess}
            >
              Open Access settings
              <ArrowRight aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function ClaimRequest({
  flow,
  busy,
  error,
  onApprove,
  onDeny,
}: {
  flow: Extract<PairingFlow, { kind: 'pair' }>
  busy: 'approve' | 'deny' | null
  error: string | null
  onApprove: () => void
  onDeny: () => void
}): JSX.Element {
  const { stage } = flow
  if (stage.kind === 'waiting') {
    return (
      <div
        className="mt-4 flex items-center gap-2 rounded-lg border border-hairline-soft bg-muted/20 p-3.5"
        role="status"
      >
        <WorkingMark size={13} />
        <p className="settings-prose">Waiting for a phone to scan this code…</p>
      </div>
    )
  }
  if (stage.kind === 'claimed') {
    return (
      <div className="mt-4 rounded-lg border border-warning/35 bg-warning/5 p-4">
        <div className="flex items-start gap-3">
          <Smartphone className="mt-0.5 size-4 flex-none text-warning" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h4 className="settings-h2">{stage.deviceName} wants to connect</h4>
            <p className="settings-micro mt-1">
              {displayPlatform({ kind: 'mobile', platform: stage.platform })}
            </p>
            <p className="settings-prose mt-3">Confirm that the phone shows these exact words:</p>
            <fieldset
              className="mt-2 border-0 p-0 font-mono text-[18px] font-semibold tracking-tight text-foreground"
              aria-label={`Verification phrase: ${stage.phrase.join(' ')}`}
            >
              {stage.phrase.join(' · ')}
            </fieldset>
            <p className="settings-micro mt-3">
              If the words differ or you do not recognize this phone, deny the request.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                pending={busy === 'approve'}
                pendingLabel="Approving…"
                disabled={busy !== null}
                onClick={onApprove}
              >
                Approve phone
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                pending={busy === 'deny'}
                pendingLabel="Denying…"
                disabled={busy !== null}
                onClick={onDeny}
              >
                Deny
              </Button>
            </div>
            {error && (
              <p role="alert" className="settings-prose mt-2 text-destructive">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
    )
  }
  let copy: readonly [string, string]
  if (stage.kind === 'approved') {
    copy = [
      'Phone approved',
      'The phone can finish connecting now. This code cannot enroll another device.',
    ]
  } else if (stage.kind === 'cancelled') {
    copy = ['Pairing code cancelled', 'This code can no longer connect a phone.']
  } else if (stage.kind === 'denied') {
    copy = ['Request denied', 'No mobile session was created.']
  } else if (stage.kind === 'expired') {
    copy = [
      'Pairing code expired',
      'No mobile session was created. The code may have timed out or been cleared by a server restart; create a new code when the phone is ready.',
    ]
  } else {
    copy = [
      'Pairing is no longer available',
      'The request may have expired or the server may have restarted. Create a new code.',
    ]
  }
  const Icon = stage.kind === 'approved' ? CheckCircle2 : TriangleAlert
  return (
    <div
      className="mt-4 flex items-start gap-3 rounded-lg border border-hairline-soft bg-muted/20 p-3.5"
      role="status"
    >
      <Icon
        aria-hidden="true"
        className={
          stage.kind === 'approved'
            ? 'mt-0.5 size-4 flex-none text-success'
            : 'mt-0.5 size-4 flex-none text-warning'
        }
      />
      <div>
        <p className="settings-label text-foreground">{copy[0]}</p>
        <p className="settings-prose mt-1">{copy[1]}</p>
      </div>
    </div>
  )
}

/** This opening's ordering rule; every row remains the shared device model. */
class AccountDevices {
  constructor(readonly request: RecordRequest<'device'>) {}
  @lazy({ equals: compareShallow }) get sessions() {
    return [...this.request.models].sort((a, b) => Number(b.current) - Number(a.current))
  }
}

/** Every sign-in belongs here, including the current device (POD-6701/POD-6704). */
export const SignedInDevicesSection = observer(function SignedInDevicesSection({
  api,
  refreshKey = 0,
  onPair,
}: {
  api: MobilePairingApi
  refreshKey?: number
  onPair?: () => void
}): JSX.Element {
  const pool = useWorklistPool()
  const account = useAccount()
  const unsyncedChangeCount = useSettingsUnsyncedChangeCount()
  const readDevices = useCallback(() => api.auth.mobileSessions.query(), [api])
  const { request, reload } = useSettingsRecords('device', readDevices, deviceKey)
  const devices = useMemo(() => (request ? new AccountDevices(request) : null), [request])
  const sessions = request?.answer === undefined ? null : (devices?.sessions ?? [])
  const [confirming, setConfirming] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const revokingRef = useRef(false)
  const pairRowId = useSettingsRowId('Pair a phone')
  const signOutRowId = useSettingsRowId('Sign out')
  const allRowId = useSettingsRowId('Sign out everywhere')
  const sessionsRegionRef = useRef<HTMLElement>(null)
  const checkingChanges = unsyncedChangeCount === null
  const warnUnsynced = unsyncedChangeCount !== null && unsyncedChangeCount > 0

  useEffect(() => {
    if (refreshKey > 0) void reload()
  }, [reload, refreshKey])

  const signOut = async (session: MobileSessionView) => {
    if (revokingRef.current || (session.current && checkingChanges)) return
    revokingRef.current = true
    setRevoking(session.sessionId)
    setError(null)
    try {
      if (session.current && account) await account.signOut()
      else {
        await api.auth.revokeMobileSession.mutate({ sessionId: session.sessionId })
        request?.cancel()
        pool?.apply({
          type: 'update',
          rows: [{ kind: 'device', id: session.sessionId, value: undefined }],
        })
      }
      setConfirming(null)
      sessionsRegionRef.current?.focus()
      if (!session.current) toast.success(`${session.deviceName} signed out.`)
    } catch (cause) {
      setConfirming(session.sessionId)
      setError(cause instanceof Error ? cause.message : SAFE_REVOKE_ERROR)
    } finally {
      revokingRef.current = false
      setRevoking(null)
    }
  }
  const signOutEverywhere = async () => {
    if (revokingRef.current || checkingChanges) return
    revokingRef.current = true
    setRevoking('all')
    setError(null)
    try {
      await memberRequest(serverConfig(window.location).httpOrigin, 'sign-out-everywhere', {})
      await account?.signOut()
      setConfirming(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t sign out everywhere. Try again.')
    } finally {
      revokingRef.current = false
      setRevoking(null)
    }
  }
  const changeConfirmation = (id: string | null) => {
    setConfirming(id)
    setError(null)
  }
  const unsyncedWarning = (
    <>
      <strong>
        {unsyncedChangeCount === 1
          ? '1 change on this device hasn’t synced yet'
          : `${unsyncedChangeCount} changes on this device haven’t synced yet`}
      </strong>{' '}
      and will be lost. Podium also clears this account’s offline data here and closes it in your
      other tabs.
    </>
  )
  return (
    <section>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="settings-h mb-1.5">Where you’re signed in</h3>
          <p className="settings-prose">
            Each device has its own sign-in. Signing one out leaves the others alone.
          </p>
        </div>
        {onPair && (
          <Button id={pairRowId} type="button" size="sm" variant="outline" onClick={onPair}>
            <Smartphone aria-hidden="true" />
            Pair a phone
          </Button>
        )}
      </header>
      <section
        ref={sessionsRegionRef}
        aria-label="Where you’re signed in"
        className="outline-none rounded-lg border border-hairline-soft"
        tabIndex={-1}
      >
        {sessions === null && !request?.error && (
          <p className="settings-prose p-4" role="status">
            Loading devices…
          </p>
        )}
        {request?.error && (
          <div className="flex flex-wrap items-center gap-2 p-4">
            <p role="alert" className="settings-prose text-destructive">
              Couldn’t load your signed-in devices.
            </p>
            <Button type="button" size="sm" variant="outline" onClick={() => void reload()}>
              Try again
            </Button>
          </div>
        )}
        {sessions?.length === 0 && (
          <p className="settings-prose p-4">No devices are signed in to your account.</p>
        )}
        {sessions?.map((session) => (
          <div key={session.sessionId} className="border-b border-hairline-soft px-4 py-3.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <DeviceIcon kind={session.kind} />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="settings-label break-words">{session.deviceName}</span>
                    {session.current && <ThisDeviceTag />}
                  </div>
                  <p className="settings-micro mt-1">
                    {displayPlatform(session)} · Last active{' '}
                    <MobileDeviceActivity session={session} />
                  </p>
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                id={session.current ? signOutRowId : undefined}
                disabled={revoking !== null || (session.current && checkingChanges)}
                pending={revoking === session.sessionId}
                pendingLabel="Signing out…"
                onClick={() => {
                  if (session.current && warnUnsynced) changeConfirmation(session.sessionId)
                  else void signOut(session)
                }}
              >
                Sign out
              </Button>
            </div>
            {confirming === session.sessionId && (
              <ConfirmInline
                sentence={
                  session.current && warnUnsynced ? (
                    unsyncedWarning
                  ) : (
                    <>
                      Sign out <strong>{session.deviceName}</strong>?
                    </>
                  )
                }
                actionLabel={
                  session.current && warnUnsynced ? 'Sign out anyway' : 'Sign out device'
                }
                destructive
                pending={revoking !== null || (session.current && checkingChanges)}
                error={error}
                onCancel={() => changeConfirmation(null)}
                onConfirm={() => signOut(session)}
              />
            )}
          </div>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
          <p className="settings-prose flex items-center gap-2">
            <LogOut size={15} aria-hidden="true" />
            Lost a device? Sign out of all of them at once.
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            id={allRowId}
            disabled={checkingChanges || revoking !== null}
            onClick={() => changeConfirmation('all')}
          >
            Sign out everywhere
          </Button>
        </div>
        {confirming === 'all' && (
          <div className="px-4">
            <ConfirmInline
              sentence={
                <>
                  {warnUnsynced && (
                    <>
                      {unsyncedWarning}
                      <br />
                    </>
                  )}
                  Sign out on every device, this one included?
                </>
              }
              actionLabel={
                warnUnsynced ? 'Sign out everywhere anyway' : 'Confirm sign out everywhere'
              }
              destructive
              pending={checkingChanges || revoking !== null}
              error={error}
              onCancel={() => changeConfirmation(null)}
              onConfirm={signOutEverywhere}
            />
          </div>
        )}
      </section>
    </section>
  )
})

const MobileDeviceActivity = observer(function MobileDeviceActivity({
  session,
}: {
  session: MobileSessionView
}) {
  const now = useAgeNow(session.lastSeenAt ?? session.createdAt, 0, session.lastSeenAt !== null)
  return <>{formatActivity(session.lastSeenAt, now)}</>
})

/** A phone-pairing takeover; its credential exists only for this mounted flow. */
export function PhonePairingFlow({
  api: injectedApi,
  onOpenAccess,
  autoStart = false,
  onSessionsChanged,
}: {
  api?: MobilePairingApi
  onOpenAccess?: () => void
  autoStart?: boolean
  onSessionsChanged?: () => void
}): JSX.Element {
  const httpOrigin = serverConfig(window.location).httpOrigin
  const api = useMemo(
    () => injectedApi ?? createMobilePairingApi(httpOrigin),
    [httpOrigin, injectedApi],
  )
  const [flow, setFlow] = useState<PairingFlow>({ kind: 'idle' })
  const [decisionBusy, setDecisionBusy] = useState<'approve' | 'deny' | 'cancel' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const activePairingRef = useRef<string | null>(null)
  const lifetime = useRef(0)
  const starting = useRef(false)
  const flowRegionRef = useRef<HTMLElement>(null)
  const previousFocusState = useRef('idle')
  const pairingDeadline =
    flow.kind === 'pair' && (flow.stage.kind === 'waiting' || flow.stage.kind === 'claimed')
      ? Date.parse(flow.start.expiresAt)
      : undefined
  const pairingDeadlineNow = useDeadlineNow(pairingDeadline)

  useEffect(() => {
    if (pairingDeadline !== undefined && pairingDeadlineNow >= pairingDeadline) {
      activePairingRef.current = null
      setFlow((current) =>
        current.kind === 'pair' ? { ...current, url: '', stage: { kind: 'expired' } } : current,
      )
    }
  }, [pairingDeadline, pairingDeadlineNow])

  useEffect(() => {
    lifetime.current += 1
    return () => {
      lifetime.current += 1
      const pairingId = activePairingRef.current
      activePairingRef.current = null
      if (pairingId) void cancelPairingOnExit(api, pairingId)
      else if (starting.current)
        toast.loading('Cancelling pairing code…', { id: 'phone-pairing-cancel' })
    }
  }, [api])

  useEffect(() => {
    const focusState = flow.kind === 'pair' ? flow.stage.kind : flow.kind
    if (focusState !== previousFocusState.current && focusState !== 'idle') {
      flowRegionRef.current?.focus()
    }
    previousFocusState.current = focusState
  }, [flow])

  useEffect(() => {
    if (flow.kind !== 'pair' || (flow.stage.kind !== 'waiting' && flow.stage.kind !== 'claimed')) {
      return
    }
    let cancelled = false
    let inFlight = false
    let failures = 0
    const pairingId = flow.start.pairingId
    const expiresAt = flow.start.expiresAt

    const poll = async (): Promise<void> => {
      if (cancelled || inFlight || document.visibilityState === 'hidden') return
      if (Date.now() >= Date.parse(expiresAt)) {
        activePairingRef.current = null
        setFlow((current) =>
          current.kind === 'pair' &&
          current.start.pairingId === pairingId &&
          (current.stage.kind === 'waiting' || current.stage.kind === 'claimed')
            ? { ...current, url: '', stage: { kind: 'expired' } }
            : current,
        )
        return
      }
      inFlight = true
      try {
        const status = await api.auth.mobilePairingStatus.query({ pairingId })
        failures = 0
        if (cancelled || status.state === 'pending') return
        if (
          status.state === 'approved' ||
          status.state === 'completed' ||
          status.state === 'denied' ||
          status.state === 'expired'
        ) {
          activePairingRef.current = null
        }
        setFlow((current) => {
          if (
            current.kind !== 'pair' ||
            current.start.pairingId !== pairingId ||
            (current.stage.kind !== 'waiting' && current.stage.kind !== 'claimed')
          )
            return current
          if (status.state === 'claimed') {
            if (current.stage.kind === 'claimed') return current
            return {
              ...current,
              url: '',
              stage: {
                kind: 'claimed',
                deviceName: status.deviceName,
                platform: status.platform,
                phrase: status.phrase,
              },
            }
          }
          if (status.state === 'approved' || status.state === 'completed') {
            return { ...current, url: '', stage: { kind: 'approved' } }
          }
          if (status.state === 'denied') {
            return { ...current, url: '', stage: { kind: 'denied' } }
          }
          return { ...current, url: '', stage: { kind: 'expired' } }
        })
      } catch {
        failures += 1
        if (!cancelled && failures >= 3) {
          setFlow((current) =>
            current.kind === 'pair' &&
            current.start.pairingId === pairingId &&
            (current.stage.kind === 'waiting' || current.stage.kind === 'claimed')
              ? { ...current, url: '', stage: { kind: 'unavailable' } }
              : current,
          )
        }
      } finally {
        inFlight = false
      }
    }

    void poll()
    const id = window.setInterval(() => void poll(), 1500)
    const resume = () => {
      if (document.visibilityState !== 'hidden') void poll()
    }
    document.addEventListener('visibilitychange', resume)
    return () => {
      cancelled = true
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [api, flow])

  // Completion happens on the phone just after browser approval. Refresh the
  // inventory a few times so the new named row arrives without requiring the
  // user to close and reopen Settings; no pairing secret is involved.
  useEffect(() => {
    if (flow.kind !== 'pair' || flow.stage.kind !== 'approved') return
    let attempts = 0
    const id = window.setInterval(() => {
      attempts += 1
      onSessionsChanged?.()
      if (attempts >= 3) window.clearInterval(id)
    }, 1500)
    return () => window.clearInterval(id)
  }, [flow, onSessionsChanged])

  const start = useCallback(async (): Promise<void> => {
    if (starting.current) return
    starting.current = true
    const generation = lifetime.current
    setFlow({ kind: 'starting' })
    setActionError(null)
    try {
      const priorPairingId = activePairingRef.current
      if (priorPairingId) {
        await api.auth.mobilePairingDeny.mutate({ pairingId: priorPairingId })
        activePairingRef.current = null
      }
      if (generation !== lifetime.current) return
      const result = await api.auth.mobilePairingStart.mutate()
      if (generation !== lifetime.current) {
        if (result.mode === 'pair') await cancelPairingOnExit(api, result.pairingId)
        else toast.success('No pairing code is active.', { id: 'phone-pairing-cancel' })
        return
      }
      if (result.mode === 'open') {
        const canonical = canonicalOrigin(result.canonicalOrigin)
        const mobileUrl = mobileServerUrl(canonical)
        if (new URL(result.mobileUrl).href !== mobileUrl) {
          throw new Error('open mobile URL does not match canonical origin')
        }
        if (new URL(canonical).protocol !== 'https:') {
          setFlow({ kind: 'error', reason: 'transport' })
          return
        }
        setFlow({ kind: 'open', url: mobileUrl })
      } else {
        const url = pairUrl(result)
        activePairingRef.current = result.pairingId
        setFlow({
          kind: 'pair',
          // Keep the server-issued temporary URL only while it must be rendered;
          // every transition out of waiting clears it from local UI state.
          start: { pairingId: result.pairingId, expiresAt: result.expiresAt },
          url,
          stage: { kind: 'waiting' },
        })
      }
    } catch (error) {
      if (generation === lifetime.current) setFlow({ kind: 'error', reason: startFailure(error) })
      else toast.error(SAFE_CANCEL_ERROR, { id: 'phone-pairing-cancel' })
    } finally {
      starting.current = false
    }
  }, [api])

  useEffect(() => {
    // An effect replay must not mint a code for an opening React already discarded.
    let active = true
    if (autoStart)
      queueMicrotask(() => {
        if (active) void start()
      })
    return () => {
      active = false
    }
  }, [autoStart, start])

  const cancel = async (): Promise<void> => {
    if (flow.kind !== 'pair') return
    setDecisionBusy('cancel')
    setActionError(null)
    try {
      await api.auth.mobilePairingDeny.mutate({ pairingId: flow.start.pairingId })
      activePairingRef.current = null
      setFlow((current) =>
        current.kind === 'pair' ? { ...current, url: '', stage: { kind: 'cancelled' } } : current,
      )
    } catch {
      setActionError(SAFE_CANCEL_ERROR)
    } finally {
      setDecisionBusy(null)
    }
  }

  const decide = async (decision: 'approve' | 'deny'): Promise<void> => {
    if (flow.kind !== 'pair' || flow.stage.kind !== 'claimed') return
    setDecisionBusy(decision)
    setActionError(null)
    const input = { pairingId: flow.start.pairingId }
    try {
      if (decision === 'approve') await api.auth.mobilePairingApprove.mutate(input)
      else await api.auth.mobilePairingDeny.mutate(input)
      activePairingRef.current = null
      setFlow((current) =>
        current.kind === 'pair'
          ? {
              ...current,
              url: '',
              stage: { kind: decision === 'approve' ? 'approved' : 'denied' },
            }
          : current,
      )
    } catch {
      setActionError(SAFE_ACTION_ERROR)
    } finally {
      setDecisionBusy(null)
    }
  }

  const canStartAgain =
    flow.kind === 'open' ||
    (flow.kind === 'error' && flow.reason !== 'public-url' && flow.reason !== 'transport') ||
    (flow.kind === 'pair' &&
      flow.stage.kind !== 'waiting' &&
      (flow.stage.kind !== 'claimed' || actionError !== null))

  const announcement =
    flow.kind === 'starting'
      ? 'Creating a temporary phone pairing code.'
      : flow.kind === 'pair' && flow.stage.kind === 'waiting'
        ? 'Pairing code ready. Waiting for a phone to scan it.'
        : flow.kind === 'pair' && flow.stage.kind === 'claimed'
          ? `${flow.stage.deviceName} wants to connect. Verification phrase: ${flow.stage.phrase.join(' ')}.`
          : flow.kind === 'pair' && flow.stage.kind === 'approved'
            ? 'Phone approved.'
            : flow.kind === 'pair' && flow.stage.kind === 'cancelled'
              ? 'Pairing code cancelled.'
              : flow.kind === 'pair' && flow.stage.kind === 'denied'
                ? 'Pairing request denied.'
                : flow.kind === 'pair' && flow.stage.kind === 'expired'
                  ? 'Pairing code expired. Create a new code.'
                  : flow.kind === 'pair' && flow.stage.kind === 'unavailable'
                    ? 'Pairing is no longer available. Create a new code.'
                    : flow.kind === 'open'
                      ? 'Mobile server link ready.'
                      : ''

  return (
    <div>
      <p className="sr-only" aria-live="assertive" aria-atomic="true">
        {announcement}
      </p>

      <section
        ref={flowRegionRef}
        aria-label="Phone pairing status"
        className="outline-none"
        tabIndex={-1}
      >
        {flow.kind === 'idle' && (
          <div className="mt-4">
            <Button type="button" onClick={() => void start()}>
              <Smartphone aria-hidden="true" />
              Pair a phone
            </Button>
          </div>
        )}

        {flow.kind === 'starting' && (
          <div className="mt-4 flex items-center gap-2" role="status">
            <WorkingMark size={13} />
            <p className="settings-prose">Creating a one-time code…</p>
          </div>
        )}

        {flow.kind === 'error' &&
          (flow.reason === 'public-url' || flow.reason === 'transport' ? (
            <PairingSetupRequired reason={flow.reason} onOpenAccess={onOpenAccess} />
          ) : (
            <div className="mt-4">
              <p role="alert" className="settings-prose text-destructive">
                {SAFE_START_ERRORS[flow.reason]}
              </p>
            </div>
          ))}

        {flow.kind === 'pair' && (
          <div className="mt-5">
            {flow.stage.kind === 'waiting' && (
              <PairingCode
                url={flow.url}
                mode="pair"
                expiresAt={flow.start.expiresAt}
                cancelling={decisionBusy === 'cancel'}
                cancelError={actionError}
                onCancel={() => void cancel()}
              />
            )}
            <ClaimRequest
              flow={flow}
              busy={decisionBusy === 'cancel' ? null : decisionBusy}
              error={actionError}
              onApprove={() => void decide('approve')}
              onDeny={() => void decide('deny')}
            />
          </div>
        )}

        {flow.kind === 'open' && (
          <div className="mt-5">
            <PairingCode url={flow.url} mode="open" />
          </div>
        )}

        {canStartAgain && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-4"
            onClick={() => void start()}
          >
            <RefreshCw aria-hidden="true" />
            {flow.kind === 'error' ? 'Try again' : 'Create a new code'}
          </Button>
        )}
      </section>
    </div>
  )
}

/** A toast outlives the takeover, so leaving never silently denies a scanning phone. */
async function cancelPairingOnExit(api: MobilePairingApi, pairingId: string): Promise<void> {
  toast.loading('Cancelling pairing code…', { id: 'phone-pairing-cancel' })
  try {
    await api.auth.mobilePairingDeny.mutate({ pairingId })
    toast.success('Pairing code cancelled.', { id: 'phone-pairing-cancel' })
  } catch {
    toast.error(SAFE_CANCEL_ERROR, { id: 'phone-pairing-cancel' })
  }
}
