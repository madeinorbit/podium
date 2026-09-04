import { randomBytes } from 'node:crypto'
import type { UserId } from '@podium/model'
import {
  encodePairingEnvelope,
  MobilePairClaimRequest,
  MobilePairCompleteRequest,
  type MobilePairEnvelope,
  MobilePairingIdRequest,
  mobilePairingUrl,
  normalizeHttpOrigin,
  RevokeMobileClientSessionRequest,
} from '@podium/protocol'
import type { Context, Hono } from 'hono'
import {
  type ClientCredentialHeaders,
  hashToken,
  isHttps,
  resolveClientCredential,
  SESSION_TTL_MS,
  setSessionCookie,
} from './auth-route'
import type { MobilePairingManager } from './mobile-pairing'
import type { AuthRepository } from './store/auth'

const PAIRING_UNAVAILABLE = { error: 'pairing unavailable' } as const

interface FailureBucket {
  failures: number
  lockedUntil: number
  expiresAt: number
}

export class PairingFailureThrottle {
  private readonly buckets = new Map<string, FailureBucket>()
  private operations = 0

  constructor(
    private readonly opts: {
      maxFailures: number
      lockoutMs: number
      retentionMs: number
      maxEntries: number
    },
  ) {
    if (
      !Number.isSafeInteger(opts.maxFailures) ||
      opts.maxFailures < 1 ||
      !Number.isSafeInteger(opts.lockoutMs) ||
      opts.lockoutMs < 1 ||
      !Number.isSafeInteger(opts.retentionMs) ||
      opts.retentionMs < 1 ||
      !Number.isSafeInteger(opts.maxEntries) ||
      opts.maxEntries < 1
    ) {
      throw new Error('pairing throttle limits must be positive integers')
    }
  }

  get size(): number {
    return this.buckets.size
  }

  retryAfter(key: string, nowMs: number): number | undefined {
    this.maybeSweep(nowMs)
    const bucket = this.buckets.get(key)
    if (!bucket) return undefined
    if (nowMs >= bucket.expiresAt) {
      this.buckets.delete(key)
      return undefined
    }
    if (nowMs >= bucket.lockedUntil) return undefined
    return Math.ceil((bucket.lockedUntil - nowMs) / 1000)
  }

  fail(key: string, nowMs: number): void {
    this.maybeSweep(nowMs)
    const current = this.buckets.get(key)
    const failures = (current && nowMs < current.expiresAt ? current.failures : 0) + 1
    const lockedUntil = failures >= this.opts.maxFailures ? nowMs + this.opts.lockoutMs : 0
    if (!current && this.buckets.size >= this.opts.maxEntries) this.evictOldest()
    this.buckets.set(key, {
      failures: lockedUntil ? 0 : failures,
      lockedUntil,
      expiresAt: lockedUntil || nowMs + this.opts.retentionMs,
    })
  }

  clear(key: string): void {
    this.buckets.delete(key)
  }

  private maybeSweep(nowMs: number): void {
    this.operations += 1
    if (this.operations % 64 !== 0) return
    for (const [key, bucket] of this.buckets) {
      if (nowMs >= bucket.expiresAt) this.buckets.delete(key)
    }
  }

  private evictOldest(): void {
    const oldestKey = this.buckets.keys().next().value as string | undefined
    if (oldestKey !== undefined) this.buckets.delete(oldestKey)
  }
}

export function clientAddressForRequest(
  request: Request,
  directPeerAddress: string | undefined,
  trustedProxyHops: number = 0,
): string | undefined {
  if (trustedProxyHops <= 0) {
    return directPeerAddress && directPeerAddress.length <= 128 ? directPeerAddress : undefined
  }
  const chain = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const index = chain.length - trustedProxyHops
  const candidate = index >= 0 ? chain[index] : undefined
  return candidate && candidate.length <= 128 ? candidate : undefined
}

function transportReadiness(serverUrl: string) {
  const hostname = new URL(serverUrl).hostname
  if (serverUrl.startsWith('https://') && hostname.endsWith('.ts.net')) {
    return {
      grade: 'tailscale' as const,
      title: 'Private and ready',
      guidance: 'Keep Tailscale connected on this phone.',
    }
  }
  if (serverUrl.startsWith('https://')) {
    return {
      grade: 'https' as const,
      title: 'HTTPS configured',
      guidance: 'The phone will verify the certificate and server name.',
    }
  }
  return {
    grade: 'insecure' as const,
    title: 'Needs secure access',
    guidance: 'Configure Tailscale Serve or a trusted HTTPS reverse proxy before signing in.',
  }
}

export interface MobilePairingRouteOptions {
  store: AuthRepository
  pairing: MobilePairingManager
  serverIdentity: () => {
    publicUrl?: string
    /** Where the web UI lives when it is not this server (PDM-26); absent means here. */
    appUrl?: string
    instanceId: string
  }
  loginRequired: () => boolean
  resolveUserId: (headers: ClientCredentialHeaders) => UserId | undefined
  now?: () => number
  trustedProxyHops?: number
  /** A verified same-host browser or desktop request may control the ceremony
   *  over loopback HTTP. Phone claim and credential delivery still require HTTPS. */
  localControlRequest?: (request: Request) => boolean
  requestPeerAddress?: (request: Request) => string | undefined
  throttle?: {
    maxFailures?: number
    lockoutMs?: number
    retentionMs?: number
    maxEntries?: number
  }
  onCredentialRevoked?: (tokenHash: string) => void
}

function headersFor(c: Context): ClientCredentialHeaders {
  return {
    cookieHeader: c.req.header('cookie'),
    authorizationHeader: c.req.header('authorization'),
  }
}

function requestKey(c: Context, opts: MobilePairingRouteOptions): string | undefined {
  return clientAddressForRequest(
    c.req.raw,
    opts.requestPeerAddress?.(c.req.raw),
    opts.trustedProxyHops,
  )
}

function isBrowserRequest(c: Context): boolean {
  return c.req.header('origin') !== undefined
}

export function registerMobilePairingRoutes(app: Hono, opts: MobilePairingRouteOptions): void {
  const now = opts.now ?? (() => Date.now())
  const maxFailures = opts.throttle?.maxFailures ?? 12
  const lockoutMs = opts.throttle?.lockoutMs ?? 60_000
  // This bounded, expiring bucket is intentionally independent of password-login throttling.
  const pairingFailures = new PairingFailureThrottle({
    maxFailures,
    lockoutMs,
    retentionMs: opts.throttle?.retentionMs ?? Math.max(lockoutMs, 60_000),
    maxEntries: opts.throttle?.maxEntries ?? 4_096,
  })
  const secure = (c: Context): boolean => isHttps(c, opts.trustedProxyHops)
  const controlTransportAllowed = (c: Context): boolean =>
    secure(c) || opts.localControlRequest?.(c.req.raw) === true

  app.post('/auth/mobile-pair/start', (c) => {
    const identity = opts.serverIdentity()
    if (!identity.publicUrl) return c.json({ error: 'public URL is not configured' }, 409)
    let serverUrl: string
    try {
      serverUrl = normalizeHttpOrigin(identity.publicUrl)
    } catch {
      return c.json({ error: 'public URL is invalid' }, 409)
    }

    if (!opts.loginRequired()) {
      return c.json({
        mode: 'open' as const,
        canonicalOrigin: serverUrl,
        mobileUrl: `${serverUrl}/mobile`,
        transport: transportReadiness(serverUrl),
        instanceId: identity.instanceId,
      })
    }

    if (!controlTransportAllowed(c) || !serverUrl.startsWith('https://')) {
      return c.json({ error: 'secure HTTPS is required for mobile pairing' }, 400)
    }
    const userId = opts.resolveUserId(headersFor(c))
    if (!userId) return c.json({ error: 'authentication required' }, 401)
    const grant = opts.pairing.mint(userId, now())
    const payload: MobilePairEnvelope = {
      v: 2,
      kind: 'mobile-client',
      mode: 'pair',
      serverUrl,
      pairCode: grant.pairCode,
      expiresAt: grant.expiresAt,
      instanceId: identity.instanceId,
    }
    const envelope = encodePairingEnvelope(payload)
    return c.json({
      mode: 'pair' as const,
      pairingId: grant.pairingId,
      envelope,
      pairingUrl: mobilePairingUrl(payload),
      canonicalOrigin: serverUrl,
      transport: transportReadiness(serverUrl),
      expiresAt: grant.expiresAt,
      instanceId: identity.instanceId,
    })
  })

  app.post('/auth/mobile-pair/claim', async (c) => {
    if (!secure(c)) return c.json({ error: 'secure HTTPS is required' }, 400)
    const at = now()
    const key = requestKey(c, opts)
    if (!key) return c.json(PAIRING_UNAVAILABLE, 503)
    const retryAfter = pairingFailures.retryAfter(key, at)
    if (retryAfter !== undefined) {
      return c.json({ error: 'too many attempts' }, 429, {
        'retry-after': String(retryAfter),
      })
    }
    const parsed = MobilePairClaimRequest.safeParse(await c.req.json().catch(() => undefined))
    const claimed = parsed.success
      ? opts.pairing.claim(parsed.data, isBrowserRequest(c) ? 'browser' : 'native', at)
      : undefined
    if (!claimed) {
      pairingFailures.fail(key, at)
      return c.json(PAIRING_UNAVAILABLE, 400)
    }
    pairingFailures.clear(key)
    return c.json(claimed)
  })

  app.post('/auth/mobile-pair/status', async (c) => {
    if (!controlTransportAllowed(c)) return c.json({ error: 'secure HTTPS is required' }, 400)
    const userId = opts.resolveUserId(headersFor(c))
    if (!userId) return c.json({ error: 'authentication required' }, 401)
    const parsed = MobilePairingIdRequest.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json(PAIRING_UNAVAILABLE, 400)
    return c.json(opts.pairing.status(parsed.data.pairingId, userId, now()))
  })

  const decision = (value: 'approved' | 'denied') => async (c: Context) => {
    if (!controlTransportAllowed(c)) return c.json({ error: 'secure HTTPS is required' }, 400)
    const userId = opts.resolveUserId(headersFor(c))
    if (!userId) return c.json({ error: 'authentication required' }, 401)
    const parsed = MobilePairingIdRequest.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success || !opts.pairing.decide(parsed.data.pairingId, userId, value, now())) {
      return c.json(PAIRING_UNAVAILABLE, 400)
    }
    return c.json({ ok: true })
  }
  app.post('/auth/mobile-pair/approve', decision('approved'))
  app.post('/auth/mobile-pair/deny', decision('denied'))

  app.post('/auth/mobile-pair/complete', async (c) => {
    if (!secure(c)) return c.json({ error: 'secure HTTPS is required' }, 400)
    const at = now()
    const key = requestKey(c, opts)
    if (!key) return c.json(PAIRING_UNAVAILABLE, 503)
    const retryAfter = pairingFailures.retryAfter(key, at)
    if (retryAfter !== undefined) {
      return c.json({ error: 'too many attempts' }, 429, {
        'retry-after': String(retryAfter),
      })
    }
    const parsed = MobilePairCompleteRequest.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) {
      pairingFailures.fail(key, at)
      return c.json(PAIRING_UNAVAILABLE, 400)
    }
    const completed = opts.pairing.complete(parsed.data.claimId, parsed.data.claimSecret, at)
    if (completed === 'pending') return c.json({ status: 'pending' as const }, 202)
    if (completed === 'invalid-secret') {
      pairingFailures.fail(key, at)
      return c.json(PAIRING_UNAVAILABLE, 400)
    }
    if (completed === 'unavailable') return c.json(PAIRING_UNAVAILABLE, 400)
    pairingFailures.clear(key)
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(at + SESSION_TTL_MS).toISOString()
    opts.store.createClientSession(hashToken(token), completed.userId, expiresAt, 'mobile', {
      sessionId: randomBytes(18).toString('base64url'),
      deviceId: completed.deviceId,
      deviceName: completed.deviceName,
      platform: completed.platform,
      lastSeenAt: new Date(at).toISOString(),
    })
    if (completed.delivery === 'browser') {
      setSessionCookie(c, token, opts.trustedProxyHops)
      return c.json({
        status: 'complete' as const,
        delivery: 'browser' as const,
        userId: completed.userId,
        expiresAt,
      })
    }
    return c.json({
      status: 'complete' as const,
      delivery: 'native' as const,
      token,
      userId: completed.userId,
      expiresAt,
    })
  })

  app.get('/auth/client-sessions', (c) => {
    if (c.req.header('authorization') && !secure(c)) {
      return c.json({ error: 'secure HTTPS is required for bearer authentication' }, 400)
    }
    const credential = resolveClientCredential(opts.store, headersFor(c), now())
    if (!credential) return c.json({ error: 'authentication required' }, 401)
    const sessions = opts.store
      .listMobileClientSessions(credential.session.userId)
      .flatMap((row) =>
        row.sessionId
          ? [
              {
                sessionId: row.sessionId,
                userId: row.userId,
                label: 'mobile' as const,
                deviceId: row.deviceId ?? 'unknown',
                deviceName: row.deviceName ?? 'Mobile device',
                platform:
                  row.platform === 'ios' || row.platform === 'android' || row.platform === 'web'
                    ? row.platform
                    : ('unknown' as const),
                createdAt: row.createdAt,
                expiresAt: row.expiresAt,
                lastSeenAt: row.lastSeenAt ?? null,
                current: row.tokenHash === credential.tokenHash,
              },
            ]
          : [],
      )
    return c.json({ sessions })
  })

  app.post('/auth/client-sessions/revoke', async (c) => {
    if (c.req.header('authorization') && !secure(c)) {
      return c.json({ error: 'secure HTTPS is required for bearer authentication' }, 400)
    }
    const credential = resolveClientCredential(opts.store, headersFor(c), now())
    if (!credential) return c.json({ error: 'authentication required' }, 401)
    const parsed = RevokeMobileClientSessionRequest.safeParse(
      await c.req.json().catch(() => undefined),
    )
    const revokedTokenHash = parsed.success
      ? opts.store.deleteOwnedMobileClientSession(parsed.data.sessionId, credential.session.userId)
      : undefined
    if (!revokedTokenHash) {
      return c.json({ error: 'mobile session not found' }, 404)
    }
    opts.onCredentialRevoked?.(revokedTokenHash)
    return c.json({ ok: true })
  })
}
