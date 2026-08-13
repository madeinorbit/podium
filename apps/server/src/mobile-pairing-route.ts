import { randomBytes } from 'node:crypto'
import type { UserId } from '@podium/model'
import {
  encodePairingEnvelope,
  mobilePairingUrl,
  MobilePairClaimRequest,
  MobilePairCompleteRequest,
  MobilePairingIdRequest,
  normalizeHttpOrigin,
  RevokeMobileClientSessionRequest,
  type MobilePairEnvelope,
} from '@podium/protocol'
import type { Context, Hono } from 'hono'
import {
  hashToken,
  isHttps,
  resolveClientCredential,
  SESSION_TTL_MS,
  setSessionCookie,
  type ClientCredentialHeaders,
} from './auth-route'
import { MobilePairingManager } from './mobile-pairing'
import type { AuthRepository } from './store/auth'

const PAIRING_UNAVAILABLE = { error: 'pairing unavailable' } as const

interface FailureBucket {
  failures: number
  lockedUntil: number
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
  serverIdentity: () => { publicUrl?: string; instanceId: string }
  loginRequired: () => boolean
  resolveUserId: (headers: ClientCredentialHeaders) => UserId | undefined
  now?: () => number
  throttle?: { maxFailures?: number; lockoutMs?: number }
  onCredentialRevoked?: (tokenHash: string) => void
}

function headersFor(c: Context): ClientCredentialHeaders {
  return {
    cookieHeader: c.req.header('cookie'),
    authorizationHeader: c.req.header('authorization'),
  }
}

function requestKey(c: Context): string {
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-real-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

export function registerMobilePairingRoutes(app: Hono, opts: MobilePairingRouteOptions): void {
  const now = opts.now ?? (() => Date.now())
  const maxFailures = opts.throttle?.maxFailures ?? 12
  const lockoutMs = opts.throttle?.lockoutMs ?? 60_000
  // This bucket is intentionally independent of password-login throttling.
  const pairingFailures = new Map<string, FailureBucket>()

  const throttled = (key: string, at: number): number | undefined => {
    const bucket = pairingFailures.get(key)
    if (!bucket || at >= bucket.lockedUntil) return undefined
    return Math.ceil((bucket.lockedUntil - at) / 1000)
  }
  const refuse = (key: string, at: number): void => {
    const current = pairingFailures.get(key)
    const failures =
      (current && (current.lockedUntil === 0 || at < current.lockedUntil) ? current.failures : 0) +
      1
    pairingFailures.set(key, {
      failures: failures >= maxFailures ? 0 : failures,
      lockedUntil: failures >= maxFailures ? at + lockoutMs : 0,
    })
  }

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

    if (!isHttps(c) || !serverUrl.startsWith('https://')) {
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
    if (!isHttps(c)) return c.json({ error: 'secure HTTPS is required' }, 400)
    const at = now()
    const key = requestKey(c)
    const retryAfter = throttled(key, at)
    if (retryAfter !== undefined) {
      return c.json({ error: 'too many attempts' }, 429, {
        'retry-after': String(retryAfter),
      })
    }
    const parsed = MobilePairClaimRequest.safeParse(await c.req.json().catch(() => undefined))
    const claimed = parsed.success ? opts.pairing.claim(parsed.data, at) : undefined
    if (!claimed) {
      refuse(key, at)
      return c.json(PAIRING_UNAVAILABLE, 400)
    }
    return c.json(claimed)
  })

  app.post('/auth/mobile-pair/status', async (c) => {
    if (!isHttps(c)) return c.json({ error: 'secure HTTPS is required' }, 400)
    const userId = opts.resolveUserId(headersFor(c))
    if (!userId) return c.json({ error: 'authentication required' }, 401)
    const parsed = MobilePairingIdRequest.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json(PAIRING_UNAVAILABLE, 400)
    return c.json(opts.pairing.status(parsed.data.pairingId, userId, now()))
  })

  const decision = (value: 'approved' | 'denied') => async (c: Context) => {
    if (!isHttps(c)) return c.json({ error: 'secure HTTPS is required' }, 400)
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
    if (!isHttps(c)) return c.json({ error: 'secure HTTPS is required' }, 400)
    const at = now()
    const key = requestKey(c)
    const retryAfter = throttled(key, at)
    if (retryAfter !== undefined) {
      return c.json({ error: 'too many attempts' }, 429, {
        'retry-after': String(retryAfter),
      })
    }
    const parsed = MobilePairCompleteRequest.safeParse(await c.req.json().catch(() => undefined))
    const completed = parsed.success
      ? opts.pairing.complete(parsed.data.claimId, parsed.data.claimSecret, at)
      : undefined
    if (completed === 'pending') return c.json({ status: 'pending' as const }, 202)
    if (!completed) {
      refuse(key, at)
      return c.json(PAIRING_UNAVAILABLE, 400)
    }
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
      setSessionCookie(c, token)
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
    if (c.req.header('authorization') && !isHttps(c)) {
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
    if (c.req.header('authorization') && !isHttps(c)) {
      return c.json({ error: 'secure HTTPS is required for bearer authentication' }, 400)
    }
    const credential = resolveClientCredential(opts.store, headersFor(c), now())
    if (!credential) return c.json({ error: 'authentication required' }, 401)
    const parsed = RevokeMobileClientSessionRequest.safeParse(
      await c.req.json().catch(() => undefined),
    )
    const revokedTokenHash = parsed.success
      ? opts.store.deleteOwnedMobileClientSession(
          parsed.data.sessionId,
          credential.session.userId,
        )
      : undefined
    if (!revokedTokenHash) {
      return c.json({ error: 'mobile session not found' }, 404)
    }
    opts.onCredentialRevoked?.(revokedTokenHash)
    return c.json({ ok: true })
  })
}
