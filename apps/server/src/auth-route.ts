/**
 * THE SIGN-IN ROUTES AND THE GUARD OF THE HUMAN-CLIENT DATA PLANE (POD-6746;
 * docs/design/people-and-sign-in.md, sections 4.1 and 5).
 *
 * Password sign-in, sign-out and status go through the shared identity
 * package. Who a request is comes from `memberOfRequest` and from nowhere
 * else: device sign-in, account, active membership, member.
 */
import { IdentityRefused, type WorkspaceIdentity } from '@podium/identity'
import { asUserId, type ServerReadiness, type UserId } from '@podium/model'
import {
  fencedMemberOf,
  MEMBER_FENCE_REFUSAL,
  memberFenceRefuses,
  NativeClientLoginRequest,
} from '@podium/protocol'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { isAllowedHttpOrigin } from './http-cors'
import { type MemberOfRequest, refusalAnswer } from './identity/member-of-request'
import { browserSignInDevice } from './sign-in-device'

export { isHttps, isSecureRequest } from './request-scheme'

/**
 * Hono middleware that gates a client surface (/trpc, /files, /sync) behind
 * the one resolution. A member continues; everybody else gets the answer of
 * specification section 5.2. CORS preflight (OPTIONS) always passes so
 * cross-origin clients can negotiate.
 */
export function clientAuthGuard(opts: {
  memberOfRequest: MemberOfRequest
  /** Extends a sign-in that is due and returns the cookie to set. */
  renew: WorkspaceIdentity['renew']
}): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return await next()
    const request = c.req.raw
    const resolution = await opts.memberOfRequest(request)
    if (resolution.kind !== 'member') {
      const { status, body } = refusalAnswer(resolution)
      return c.json(body, status)
    }
    // THE MEMBER FENCE (POD-6292, MU-12): a client opened for one member never
    // acts with another member's credential. It can only refuse; identity still
    // comes from the credential alone.
    if (memberFenceRefuses(fencedMemberOf(request), resolution.memberId)) {
      return memberFenceRefusal(c)
    }
    // THE DAILY RENEWAL. A sign-in last renewed more than a day ago is pushed
    // back out to its full life, here, where the response can carry the cookie.
    // A sign-in whose life was chosen when it was made is never due.
    const renewed = resolution.renewDue
      ? await opts.renew(request, opts.memberOfRequest.factsOf(request))
      : undefined
    await next()
    const cookies = renewed?.getSetCookie() ?? []
    for (const cookie of cookies) c.header('set-cookie', cookie, { append: true })
    if (cookies.length > 0) c.header('cache-control', 'no-store')
  }
}

/** 401, so every client treats it as the end of its signed-in session and rebinds. */
function memberFenceRefusal(c: Context): Response {
  return c.json({ error: 'signed in as a different member', code: MEMBER_FENCE_REFUSAL }, 401)
}

export interface AuthRouteOptions {
  /** Installation id for self-hosted, workspace id for hosted. */
  syncBoundaryId?: () => string
  identity: WorkspaceIdentity
  /** The one resolver every human-client transport uses. */
  memberOfRequest: MemberOfRequest
  /**
   * Whether `GET /auth/status` may report a signed-in caller yet. The control
   * plane, not the data plane (POD-2766): while activation is pending the
   * operator can sign in, so a sign-in that exists has to be reported, or the
   * login screen loops against a server that just accepted the password.
   */
  controlPlaneAvailable?: () => boolean
  /** The member whose row carries this account, for the answer of a sign-in. */
  memberOfAccount: (accountId: string) => Promise<{ id: string } | undefined>
  /** Origins beside the request's own host that may change something here. */
  allowedOrigins?: ReadonlySet<string>
  /** The same request locality rule as the open-mode transport guard. */
  isLocalRequest?: (request: Request) => boolean
  /** Same public lifecycle projection served by GET /readiness. */
  readiness?: () => ServerReadiness
  /** A device sign-in ended through this server: its open sockets close now. */
  onDeviceSignInEnded?: (deviceSignInId: string) => void
  /**
   * A successful sign-in, for a composition root that publishes it. Fired
   * after the device sign-in exists. Best-effort by contract: the call site
   * swallows a throw, because an observer must never turn a good sign-in into
   * a 500.
   */
  onLogin?: (event: { userId: UserId; delivery: 'cookie' | 'native'; platform?: string }) => void
}

/** The fragment may select a page on the moved server only. */
function transferDestination(next: string, requestUrl: string): string {
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/'
  const base = new URL(requestUrl)
  try {
    const target = new URL(next, base)
    if (target.origin === base.origin && !target.pathname.startsWith('//')) {
      return target.pathname + target.search + target.hash
    }
  } catch {
    // Malformed paths have the same safe landing page as cross-origin URLs.
  }
  return '/'
}

export function registerAuthRoute(app: Hono, opts: AuthRouteOptions): void {
  const { identity, memberOfRequest } = opts
  const { core } = identity

  /**
   * The package builds its own request to the sign-in library and never shows
   * it the caller's origin, so the server checks it first (section 2.3). No
   * Origin header at all is a same-origin or native caller.
   */
  const foreignOrigin = (c: Context): boolean => {
    const origin = c.req.header('origin')
    return (
      origin !== undefined &&
      !isAllowedHttpOrigin(origin, new URL(c.req.url).host, opts.allowedOrigins)
    )
  }
  const appendCookies = (c: Context, headers: Headers): void => {
    const cookies = headers.getSetCookie()
    for (const cookie of cookies) c.header('set-cookie', cookie, { append: true })
    if (cookies.length > 0) c.header('cache-control', 'no-store')
  }

  app.get('/auth/status', async (c) => {
    const [needsAuth, prompt, resolution] = await Promise.all([
      identity.signInRequired(),
      core.signIn.prompt(),
      (opts.controlPlaneAvailable?.() ?? true)
        ? memberOfRequest(c.req.raw)
        : ({ kind: 'unauthenticated' } as const),
    ])
    const member = resolution.kind === 'member' ? resolution : undefined
    return c.json({
      needsAuth,
      authed: member !== undefined,
      // Signed in, and not a member of this workspace: the screen says so and
      // offers another account instead of the sign-in form again.
      ...(resolution.kind === 'not-a-member' ? { denied: 'not_workspace_member' as const } : {}),
      ...(member
        ? {
            userId: member.memberId,
            memberId: member.memberId,
            syncBoundaryId: opts.syncBoundaryId?.(),
          }
        : {}),
      // What this edition offers. It holds no secret and is the same for every caller.
      capabilities: core.capabilities(),
      prompt,
      ...(opts.readiness ? { readiness: opts.readiness() } : {}),
    })
  })

  app.get('/auth/server-transfer-claim', (c) =>
    c.html(
      `<!doctype html><meta charset="utf-8"><title>Moving Podium…</title><p>Connecting to the moved server…</p><script>const p=new URLSearchParams(location.hash.slice(1));history.replaceState(null,'',location.pathname);const token=p.get('token');const next=p.get('next')||'/';const deviceKind=p.get('deviceKind')||'browser';if(!token){location.replace('/');}else{const f=document.createElement('form');f.method='post';f.action='/auth/server-transfer-claim';for(const [name,value] of [['token',token],['next',next],['deviceKind',deviceKind]]){const i=document.createElement('input');i.type='hidden';i.name=name;i.value=value;f.appendChild(i);}document.body.appendChild(f);f.submit();}</script>`,
      200,
      {
        'cache-control': 'no-store',
        'content-security-policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'none'; base-uri 'none'; form-action 'self'",
        // no-referrer makes browsers send Origin: null on the form POST.
        // The claim stays in a fragment, and no referrer leaves this origin.
        'referrer-policy': 'same-origin',
      },
    ),
  )

  app.post('/auth/server-transfer-claim', async (c) => {
    if (foreignOrigin(c)) return c.json({ error: 'Origin refused' }, 403)
    c.header('cache-control', 'no-store')
    let body: Record<string, string | File>
    try {
      body = await c.req.parseBody()
    } catch {
      return c.redirect('/?serverTransferClaim=invalid', 303)
    }
    const code = typeof body.token === 'string' ? body.token : ''
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return c.redirect('/?serverTransferClaim=invalid', 303)
    const requestedNext = typeof body.next === 'string' ? body.next : '/'
    const next = transferDestination(requestedNext, c.req.url)
    const device = browserSignInDevice(
      c.req.header('user-agent'),
      c.req.header('origin'),
      body.deviceKind === 'desktop',
    )
    try {
      const issued = await core.codes.redeem(
        { code, purpose: 'transfer-claim' },
        device,
        'cookie',
        memberOfRequest.factsOf(c.req.raw),
      )
      if (!issued || issued === 'pending') return c.redirect('/?serverTransferClaim=invalid', 303)
      if (!(await opts.memberOfAccount(issued.accountId))) {
        await core.deviceSignIns.revoke(issued.deviceSignInId)
        return c.redirect('/?serverTransferClaim=invalid', 303)
      }
      appendCookies(c, issued.headers)
      return c.redirect(next, 303)
    } catch (error) {
      if (error instanceof IdentityRefused && error.code === 'https_required') {
        return c.json({ error: error.code }, 400)
      }
      throw error
    }
  })

  app.post('/auth/login', async (c) => {
    if (foreignOrigin(c)) return c.json({ error: 'Origin refused' }, 403)
    const required = await identity.signInRequired()
    if (!required && !opts.isLocalRequest?.(c.req.raw)) {
      // Sign-in is not required here; there is nothing to sign in to.
      return c.json({ error: 'auth disabled' }, 400)
    }
    let body: {
      delivery?: unknown
      email?: unknown
      password?: unknown
      deviceKind?: unknown
      prepareSignIn?: unknown
    } = {}
    try {
      body = ((await c.req.json()) ?? {}) as typeof body
    } catch {
      if (!required) return c.json({ error: 'auth disabled' }, 400)
      // An unreadable body carries no password and is refused like a wrong one.
    }
    // Access takes a real cookie before closing the local open-mode gate.
    // This is an explicit browser-only request and still verifies the password below.
    if (!required && (body.prepareSignIn !== true || body.delivery === 'native')) {
      return c.json({ error: 'auth disabled' }, 400)
    }
    let native: NativeClientLoginRequest | undefined
    if (body.delivery === 'native') {
      // Browsers attach Origin to POST requests and must stay on the HttpOnly
      // cookie path. Native fetch does not attach it, so a web caller cannot
      // opt into the response-body bearer intended for SecureStore.
      if (c.req.header('origin') !== undefined) {
        return c.json({ error: 'native login delivery is unavailable to browsers' }, 400)
      }
      const parsed = NativeClientLoginRequest.safeParse(body)
      if (!parsed.success) return c.json({ error: 'invalid native login request' }, 400)
      native = parsed.data
    }
    if (
      body.email !== undefined &&
      (typeof body.email !== 'string' || !body.email.trim() || body.email.length > 254)
    ) {
      return c.json({ error: 'invalid email' }, 400)
    }

    // The package owns the rest: who a sign-in without an address means, the
    // budget per identifier, the password check, and the active membership.
    const outcome = await core.signIn.password(
      {
        ...(typeof body.email === 'string' ? { email: body.email } : {}),
        password: typeof body.password === 'string' ? body.password : '',
        device: native
          ? {
              kind: 'phone',
              name: native.deviceName,
              deviceId: native.deviceId,
              platform: native.platform,
            }
          : browserSignInDevice(
              c.req.header('user-agent'),
              c.req.header('origin'),
              body.deviceKind === 'desktop',
            ),
        delivery: native ? 'bearer' : 'cookie',
      },
      memberOfRequest.factsOf(c.req.raw),
    )
    if ('refused' in outcome) {
      if (outcome.refused === 'throttled') {
        return c.json({ error: 'too many attempts' }, 429, {
          'retry-after': String(outcome.retryAfterSeconds),
        })
      }
      if (outcome.refused === 'https_required') return c.json({ error: 'https_required' }, 400)
      return c.json({ error: 'invalid password' }, 401)
    }

    // A sign-in is only issued to an account with an active membership, and
    // apply-membership wrote that account onto the member's row.
    const member = await opts.memberOfAccount(outcome.accountId)
    if (!member) {
      await core.deviceSignIns.revoke(outcome.deviceSignInId)
      return c.json({ error: 'invalid password' }, 401)
    }
    const userId = asUserId(member.id)
    try {
      opts.onLogin?.({
        userId,
        delivery: native ? 'native' : 'cookie',
        ...(native?.platform ? { platform: native.platform } : {}),
      })
    } catch {}

    if (native) {
      return c.json({
        ok: true as const,
        delivery: 'native' as const,
        syncBoundaryId: opts.syncBoundaryId?.(),
        memberId: userId,
        token: outcome.bearer,
        userId,
        expiresAt: outcome.expiresAt.toISOString(),
      })
    }
    appendCookies(c, outcome.headers)
    return c.json({ ok: true, userId, memberId: userId, syncBoundaryId: opts.syncBoundaryId?.() })
  })

  // Enrollment is invite-and-claim; callers can no longer choose member ids or passwords.
  app.post('/auth/users', (c) =>
    c.json({ error: 'Create an invite through /auth/members/invite instead' }, 410),
  )

  app.post('/auth/logout', async (c) => {
    if (foreignOrigin(c)) return c.json({ error: 'Origin refused' }, 403)
    // Ends the one device sign-in this request carries and clears its cookie.
    // The member's other devices, and their agents, are not touched.
    const ended = await core.signIn.signOut(c.req.raw, memberOfRequest.factsOf(c.req.raw))
    if (ended.deviceSignInId) opts.onDeviceSignInEnded?.(ended.deviceSignInId)
    appendCookies(c, ended.headers)
    return c.json({ ok: true })
  })
}
