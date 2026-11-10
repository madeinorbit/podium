import { createHash } from 'node:crypto'
import type { WorkspaceIdentity } from '@podium/identity'
import {
  encodePairingEnvelope,
  MobilePairClaimRequest,
  MobilePairCompleteRequest,
  type MobilePairEnvelope,
  MobilePairingIdRequest,
  mobilePairingPhraseFromDigest,
  mobilePairingUrl,
  normalizeHttpOrigin,
} from '@podium/protocol'
import type { Context, Hono } from 'hono'
import { isAllowedHttpOrigin } from './http-cors'
import { type MemberOfRequest, refusalAnswer } from './identity/member-of-request'

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
  identity: WorkspaceIdentity
  memberOfRequest: MemberOfRequest
  memberOfAccount: (accountId: string) => Promise<{ id: string } | undefined>
  allowedOrigins?: ReadonlySet<string>
  serverIdentity: () => {
    publicUrl?: string
    instanceId: string
    /** Immutable hosted workspace registry identity, absent for self-hosted installs. */
    workspaceId?: string
    /** The installation's durable identity (PDM-51): what a client stores to find
     *  this server again through Podium Connect and to verify it is the same one. */
    installationId?: string
    installationPublicKey?: string
  }
  now?: () => number
  throttle?: {
    maxFailures?: number
    lockoutMs?: number
    retentionMs?: number
    maxEntries?: number
  }
}

/** Existing phone builds display these same three words for these same bytes. */
function pairingPhrase(claimId: string, challenge: string): [string, string, string] {
  const digest = createHash('sha256')
    .update(`podium-mobile-phrase\0${claimId}\0${challenge}`)
    .digest()
  return mobilePairingPhraseFromDigest(digest)
}

const deliveryOf = (c: Context) => (c.req.header('origin') === undefined ? 'bearer' : 'cookie')

/** Both or neither: a key without its id, or the reverse, is not an identity. */
function installationFields(identity: {
  installationId?: string
  installationPublicKey?: string
}): { installationId: string; installationPublicKey: string } | Record<never, never> {
  return identity.installationId && identity.installationPublicKey
    ? {
        installationId: identity.installationId,
        installationPublicKey: identity.installationPublicKey,
      }
    : {}
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
  const { identity, memberOfRequest } = opts
  const { codes, deviceSignIns } = identity.core
  const factsOf = (c: Context) => memberOfRequest.factsOf(c.req.raw)
  const secure = (c: Context) => factsOf(c).scheme === 'https'
  const controlTransportAllowed = (c: Context) => secure(c) || factsOf(c).sameMachine
  const signedInDevice = async (c: Context) => {
    const caller = await memberOfRequest(c.req.raw)
    if (caller.kind !== 'member') {
      const refusal = refusalAnswer(caller)
      return c.json(refusal.body, refusal.status)
    }
    if (!caller.deviceSignIn) return c.json({ error: 'authentication required' }, 401)
    return { accountId: caller.accountId, signInId: caller.deviceSignIn.id }
  }

  app.use('/auth/mobile-pair/*', async (c, next) => {
    c.header('cache-control', 'no-store')
    const origin = c.req.header('origin')
    if (
      origin !== undefined &&
      !isAllowedHttpOrigin(origin, new URL(c.req.url).host, opts.allowedOrigins)
    ) {
      return c.json({ error: 'Origin refused' }, 403)
    }
    await next()
  })

  app.post('/auth/mobile-pair/start', async (c) => {
    const server = opts.serverIdentity()
    if (!server.publicUrl) return c.json({ error: 'public URL is not configured' }, 409)
    let serverUrl: string
    try {
      serverUrl = normalizeHttpOrigin(server.publicUrl)
    } catch {
      return c.json({ error: 'public URL is invalid' }, 409)
    }

    if (!(await identity.signInRequired())) {
      return c.json({
        mode: 'open' as const,
        canonicalOrigin: serverUrl,
        mobileUrl: `${serverUrl}/mobile`,
        ...(server.workspaceId ? { workspaceId: server.workspaceId } : {}),
        transport: transportReadiness(serverUrl),
        instanceId: server.instanceId,
        ...installationFields(server),
      })
    }

    if (!controlTransportAllowed(c) || !serverUrl.startsWith('https://')) {
      return c.json({ error: 'secure HTTPS is required for mobile pairing' }, 400)
    }
    const caller = await signedInDevice(c)
    if (caller instanceof Response) return caller
    const grant = await codes.issue({
      purpose: 'pair-device',
      accountId: caller.accountId,
      createdBy: caller.signInId,
    })
    const payload: MobilePairEnvelope = {
      v: 2,
      kind: 'mobile-client',
      mode: 'pair',
      serverUrl,
      pairCode: grant.code,
      ...(server.workspaceId ? { workspaceId: server.workspaceId } : {}),
      expiresAt: grant.expiresAt.toISOString(),
      instanceId: server.instanceId,
      ...installationFields(server),
    }
    const envelope = encodePairingEnvelope(payload)
    return c.json({
      mode: 'pair' as const,
      pairingId: grant.id,
      envelope,
      pairingUrl: mobilePairingUrl(payload),
      canonicalOrigin: serverUrl,
      ...(server.workspaceId ? { workspaceId: server.workspaceId } : {}),
      transport: transportReadiness(serverUrl),
      expiresAt: grant.expiresAt.toISOString(),
      instanceId: server.instanceId,
    })
  })

  app.post('/auth/mobile-pair/claim', async (c) => {
    if (!secure(c)) return c.json({ error: 'secure HTTPS is required' }, 400)
    const at = now()
    const key = factsOf(c).clientAddress
    if (!key) return c.json(PAIRING_UNAVAILABLE, 503)
    const retryAfter = pairingFailures.retryAfter(key, at)
    if (retryAfter !== undefined) {
      return c.json({ error: 'too many attempts' }, 429, {
        'retry-after': String(retryAfter),
      })
    }
    const parsed = MobilePairClaimRequest.safeParse(await c.req.json().catch(() => undefined))
    const claimed = parsed.success
      ? await codes.claim({
          code: parsed.data.pairCode,
          challenge: parsed.data.claimHash,
          device: {
            kind: 'phone',
            deviceId: parsed.data.deviceId,
            name: parsed.data.deviceName,
            platform: parsed.data.platform,
          },
          delivery: deliveryOf(c),
          phrase: pairingPhrase,
        })
      : undefined
    if (!claimed) {
      pairingFailures.fail(key, at)
      return c.json(PAIRING_UNAVAILABLE, 400)
    }
    pairingFailures.clear(key)
    return c.json({ ...claimed, expiresAt: claimed.expiresAt.toISOString() })
  })

  app.post('/auth/mobile-pair/status', async (c) => {
    if (!controlTransportAllowed(c)) return c.json({ error: 'secure HTTPS is required' }, 400)
    const caller = await signedInDevice(c)
    if (caller instanceof Response) return caller
    const parsed = MobilePairingIdRequest.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json(PAIRING_UNAVAILABLE, 400)
    const status = await codes.status(parsed.data.pairingId, caller.accountId)
    if (status.state === 'claimed' || status.state === 'approved') {
      return c.json({
        state: status.state,
        expiresAt: status.expiresAt.toISOString(),
        deviceId: status.device.deviceId,
        deviceName: status.device.name,
        platform: status.device.platform,
        delivery: status.delivery === 'bearer' ? 'native' : 'browser',
        phrase: status.phrase,
      })
    }
    return c.json(status)
  })

  const decision = (value: 'approved' | 'denied') => async (c: Context) => {
    if (!controlTransportAllowed(c)) return c.json({ error: 'secure HTTPS is required' }, 400)
    const caller = await signedInDevice(c)
    if (caller instanceof Response) return caller
    const parsed = MobilePairingIdRequest.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success || !(await codes.decide(parsed.data.pairingId, caller.accountId, value))) {
      return c.json(PAIRING_UNAVAILABLE, 400)
    }
    return c.json({ ok: true })
  }
  app.post('/auth/mobile-pair/approve', decision('approved'))
  app.post('/auth/mobile-pair/deny', decision('denied'))

  app.post('/auth/mobile-pair/complete', async (c) => {
    if (!secure(c)) return c.json({ error: 'secure HTTPS is required' }, 400)
    const at = now()
    const key = factsOf(c).clientAddress
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
    const completed = await codes.redeem(
      {
        claimId: parsed.data.claimId,
        // The phone hashes the original bytes, not the base64url text it sends.
        verifier: Buffer.from(parsed.data.claimSecret, 'base64url'),
        onWrongVerifier: () => pairingFailures.fail(key, at),
      },
      { kind: 'phone' },
      deliveryOf(c),
      factsOf(c),
    )
    if (completed === 'pending') return c.json({ status: 'pending' as const }, 202)
    if (!completed) return c.json(PAIRING_UNAVAILABLE, 400)
    const member = await opts.memberOfAccount(completed.accountId)
    if (!member) {
      await deviceSignIns.revoke(completed.deviceSignInId)
      return c.json(PAIRING_UNAVAILABLE, 400)
    }
    pairingFailures.clear(key)
    const result = {
      status: 'complete' as const,
      userId: member.id,
      expiresAt: completed.expiresAt.toISOString(),
    }
    if (completed.bearer) {
      return c.json({ ...result, delivery: 'native' as const, token: completed.bearer })
    }
    for (const cookie of completed.headers.getSetCookie()) {
      c.header('set-cookie', cookie, { append: true })
    }
    return c.json({ ...result, delivery: 'browser' as const })
  })
}
