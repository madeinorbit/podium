import { relativeTime } from '@podium/client-core/focus'
import {
  MobileClientSession as MobileClientSessionSchema,
  MobilePairStartResponse,
  MobilePairStatusResponse,
  RevokeMobileClientSessionRequest,
  type MobileClientSession as MobileSessionView,
  type MobilePairStartResponse as MobilePairStart,
  type MobilePairStatusResponse as MobilePairStatus,
  type MobileTransportReadiness,
} from '@podium/protocol'
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { serverConfig, type Trpc } from '@/app/trpc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Section, Subsection } from './shared'

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
  'public-url': 'Set a valid Public URL under Settings → Network, then try again.',
  transport:
    'Mobile pairing requires trusted HTTPS. Configure Tailscale Serve or a trusted HTTPS reverse proxy under Settings → Network.',
  auth: 'Your sign-in is no longer authorized. Sign in again, then create a new code.',
  unavailable: 'Couldn’t reach this server. Check the connection and try again.',
  'invalid-response':
    'This server returned an unexpected pairing response. Update or restart Podium, then try again.',
}
const SAFE_ACTION_ERROR = 'Couldn’t update this pairing request. Create a new code and try again.'
const SAFE_CANCEL_ERROR =
  'Couldn’t cancel this request. Keep the link private; it will expire automatically.'
const SAFE_REVOKE_ERROR = 'Couldn’t revoke this device. Nothing changed.'

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
    response = await fetch(input, init)
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
          const response = await requestJson(`${httpOrigin}/auth/client-sessions`, {
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

function displayPlatform(platform: string): string {
  const normalized = platform.trim().toLowerCase()
  if (normalized === 'ios') return 'iOS'
  if (normalized === 'android') return 'Android'
  if (normalized === 'web') return 'Web'
  return platform.trim() || 'Mobile'
}

function formatActivity(value: string | null, now: number): string {
  if (!value) return 'No activity yet'
  return relativeTime(value, now)
}

function secondsRemaining(expiresAt: string, now: number): number {
  const remaining = Date.parse(expiresAt) - now
  return Number.isFinite(remaining) ? Math.max(0, Math.ceil(remaining / 1000)) : 0
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
  const [now, setNow] = useState(() => Date.now())
  const [feedback, setFeedback] = useState<string | null>(null)

  useEffect(() => {
    if (!expiresAt) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [expiresAt])

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
        {expiresAt && (
          <p className="settings-micro mt-2 font-mono tabular-nums">
            Expires in {secondsRemaining(expiresAt, now)}s
          </p>
        )}
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

function Readiness({ origin, readiness }: { origin: string; readiness: MobileTransportReadiness }) {
  const ready = readiness.grade !== 'insecure'
  const Icon = ready ? ShieldCheck : TriangleAlert
  return (
    <div className="rounded-lg border border-hairline-soft bg-muted/20 p-3.5">
      <div className="flex min-w-0 items-start gap-3">
        <Icon
          aria-hidden="true"
          className={
            ready ? 'mt-0.5 size-4 flex-none text-success' : 'mt-0.5 size-4 flex-none text-warning'
          }
        />
        <div className="min-w-0">
          <p className="settings-label break-all font-mono">{origin}</p>
          <p className="settings-prose mt-1 font-medium text-foreground">{readiness.title}</p>
          <p className="settings-prose mt-1">{readiness.guidance}</p>
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
        <span className="spb" aria-hidden="true" />
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
            <p className="settings-micro mt-1">{displayPlatform(stage.platform)}</p>
            <p className="settings-prose mt-3">Confirm that the phone shows these exact words:</p>
            <div
              role="group"
              className="mt-2 flex flex-wrap gap-x-2 gap-y-1 font-mono text-[18px] font-semibold tracking-tight text-foreground"
              aria-label={`Verification phrase: ${stage.phrase.join(' ')}`}
            >
              {stage.phrase.map((word, index) => (
                <span key={`${index}-${word}`}>
                  {index > 0 && <span aria-hidden="true"> </span>}
                  {word}
                  {index < stage.phrase.length - 1 && (
                    <span className="ml-2 text-muted-foreground" aria-hidden="true">
                      ·
                    </span>
                  )}
                </span>
              ))}
            </div>
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

function MobileSessions({
  api,
  refreshKey,
}: {
  api: MobilePairingApi
  refreshKey: number
}): JSX.Element {
  const [sessions, setSessions] = useState<MobileSessionView[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const loadGeneration = useRef(0)
  const confirmationRef = useRef<HTMLDivElement>(null)
  const sessionsRegionRef = useRef<HTMLDivElement>(null)

  const load = useCallback((): void => {
    const generation = ++loadGeneration.current
    setLoadError(false)
    api.auth.mobileSessions
      .query()
      .then((nextSessions) => {
        if (generation === loadGeneration.current) setSessions(nextSessions)
      })
      .catch(() => {
        if (generation === loadGeneration.current) setLoadError(true)
      })
  }, [api])

  useEffect(() => {
    load()
    return () => {
      loadGeneration.current += 1
    }
  }, [load, refreshKey])
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])
  useEffect(() => {
    if (confirming) confirmationRef.current?.focus()
  }, [confirming])

  const revoke = async (session: MobileSessionView): Promise<void> => {
    setRevoking(session.sessionId)
    setRevokeError(null)
    try {
      await api.auth.revokeMobileSession.mutate({ sessionId: session.sessionId })
      loadGeneration.current += 1
      setSessions((current) => current?.filter((row) => row.sessionId !== session.sessionId) ?? [])
      setConfirming(null)
      window.setTimeout(() => sessionsRegionRef.current?.focus(), 0)
    } catch {
      setRevokeError(SAFE_REVOKE_ERROR)
    } finally {
      setRevoking(null)
    }
  }

  return (
    <Subsection
      title="Connected phones"
      hint="Each phone has its own revocable session. Revoking one phone does not sign out your other devices."
    >
      <div
        ref={sessionsRegionRef}
        role="region"
        aria-label="Connected phones"
        className="outline-none"
        tabIndex={-1}
      >
        {sessions === null && !loadError && <p className="settings-prose">Loading devices…</p>}
        {loadError && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="settings-prose text-destructive">
              Couldn’t load connected phones.
            </p>
            <Button type="button" size="xs" variant="outline" onClick={load}>
              <RefreshCw aria-hidden="true" />
              Try again
            </Button>
          </div>
        )}
        {sessions?.length === 0 && (
          <p className="settings-prose">No mobile devices are connected to your account.</p>
        )}
        {sessions && sessions.length > 0 && (
          <div className="divide-y divide-hairline-soft/70 border-y border-hairline-soft/70">
            {sessions.map((session) => {
              const isConfirming = confirming === session.sessionId
              return (
                <div key={session.sessionId} className="py-3.5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <Smartphone
                        className="mt-0.5 size-4 flex-none text-muted-foreground"
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="settings-label truncate text-foreground">
                            {session.deviceName}
                          </p>
                          {session.current && (
                            <Badge variant="outline" className="h-4 px-1.5 text-[11px]">
                              This device
                            </Badge>
                          )}
                        </div>
                        <p className="settings-micro mt-1">
                          {displayPlatform(session.platform)} · Last active{' '}
                          {formatActivity(session.lastSeenAt, now)}
                        </p>
                      </div>
                    </div>
                    {!isConfirming && (
                      <Button
                        type="button"
                        size="xs"
                        variant="destructive"
                        className="self-start sm:self-auto"
                        onClick={() => {
                          setConfirming(session.sessionId)
                          setRevokeError(null)
                        }}
                      >
                        Revoke
                      </Button>
                    )}
                  </div>
                  {isConfirming && (
                    <div
                      ref={confirmationRef}
                      className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 outline-none"
                      role="group"
                      aria-label={`Confirm revoking ${session.deviceName}`}
                      tabIndex={-1}
                    >
                      <p className="settings-prose">
                        Revoke <strong>{session.deviceName}</strong>?{' '}
                        {session.current
                          ? 'This is your current device, so this browser will be signed out immediately.'
                          : 'It will lose access immediately; your other devices stay signed in.'}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="xs"
                          variant="destructive"
                          pending={revoking === session.sessionId}
                          pendingLabel="Revoking…"
                          onClick={() => void revoke(session)}
                        >
                          Revoke device
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={revoking !== null}
                          onClick={() => {
                            setConfirming(null)
                            setRevokeError(null)
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                      {revokeError && (
                        <p role="alert" className="settings-prose mt-2 text-destructive">
                          {revokeError}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Subsection>
  )
}

/** Settings → Connected devices: mint, approve, and revoke mobile access. */
export function ConnectedDevicesSection({
  trpc,
  api: injectedApi,
}: {
  trpc?: Trpc
  api?: MobilePairingApi
}): JSX.Element {
  const httpOrigin = serverConfig(window.location).httpOrigin
  const api = useMemo(
    () => injectedApi ?? createMobilePairingApi(httpOrigin),
    [httpOrigin, injectedApi, trpc],
  )
  const [origin, setOrigin] = useState<string | null>(null)
  const [readiness, setReadiness] = useState<MobileTransportReadiness | null>(null)
  const [flow, setFlow] = useState<PairingFlow>({ kind: 'idle' })
  const [decisionBusy, setDecisionBusy] = useState<'approve' | 'deny' | 'cancel' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [sessionRefresh, setSessionRefresh] = useState(0)
  const activePairingRef = useRef<string | null>(null)
  const flowRegionRef = useRef<HTMLDivElement>(null)
  const previousFocusState = useRef('idle')

  useEffect(() => {
    return () => {
      const pairingId = activePairingRef.current
      activePairingRef.current = null
      if (pairingId) {
        void api.auth.mobilePairingDeny.mutate({ pairingId }).catch(() => {})
      }
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
      if (cancelled || inFlight) return
      if (Date.now() >= Date.parse(expiresAt)) {
        activePairingRef.current = null
        setFlow((current) =>
          current.kind === 'pair' && current.start.pairingId === pairingId
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
          if (current.kind !== 'pair' || current.start.pairingId !== pairingId) return current
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
            current.kind === 'pair' && current.start.pairingId === pairingId
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
    return () => {
      cancelled = true
      window.clearInterval(id)
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
      setSessionRefresh((value) => value + 1)
      if (attempts >= 3) window.clearInterval(id)
    }, 1500)
    return () => window.clearInterval(id)
  }, [flow])

  const start = async (): Promise<void> => {
    const priorPairingId = activePairingRef.current
    activePairingRef.current = null
    if (priorPairingId) {
      void api.auth.mobilePairingDeny.mutate({ pairingId: priorPairingId }).catch(() => {})
    }
    setFlow({ kind: 'starting' })
    setActionError(null)
    try {
      const result = await api.auth.mobilePairingStart.mutate()
      if (result.mode === 'open') {
        const canonical = canonicalOrigin(result.canonicalOrigin)
        const mobileUrl = mobileServerUrl(canonical)
        if (new URL(result.mobileUrl).href !== mobileUrl) {
          throw new Error('open mobile URL does not match canonical origin')
        }
        setOrigin(canonical)
        setReadiness(result.transport)
        setFlow({ kind: 'open', url: mobileUrl })
      } else {
        const url = pairUrl(result)
        setOrigin(result.canonicalOrigin)
        setReadiness(result.transport)
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
      setFlow({ kind: 'error', reason: startFailure(error) })
    }
  }

  const cancel = async (): Promise<void> => {
    if (flow.kind !== 'pair') return
    setDecisionBusy('cancel')
    setActionError(null)
    try {
      await api.auth.mobilePairingDeny.mutate({ pairingId: flow.start.pairingId })
      activePairingRef.current = null
      setFlow((current) =>
        current.kind === 'pair' ? { ...current, url: '', stage: { kind: 'denied' } } : current,
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
    flow.kind === 'error' ||
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
    <>
      <Section
        title="Connected devices"
        hint="Pair a phone with this server, approve the device you are holding, and revoke mobile access one device at a time."
      >
        <p className="sr-only" aria-live="assertive" aria-atomic="true">
          {announcement}
        </p>

        {origin && readiness ? (
          <Readiness origin={origin} readiness={readiness} />
        ) : (
          <div className="rounded-lg border border-hairline-soft bg-muted/20 p-3.5">
            <p className="settings-label">Server pairing address</p>
            <p className="settings-prose mt-1">
              Podium will use the server’s configured Public URL and show its connection guidance
              here.
            </p>
          </div>
        )}

        <div
          ref={flowRegionRef}
          role="region"
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
              <span className="spb" aria-hidden="true" />
              <p className="settings-prose">Creating a one-time code…</p>
            </div>
          )}

          {flow.kind === 'error' && (
            <div className="mt-4">
              <p role="alert" className="settings-prose text-destructive">
                {SAFE_START_ERRORS[flow.reason]}
              </p>
            </div>
          )}

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
              Create a new code
            </Button>
          )}
        </div>
      </Section>
      <MobileSessions api={api} refreshKey={sessionRefresh} />
    </>
  )
}
