/** The caller's devices and the admin view of workspace sign-ins. */
import type { DeviceSignIn, WorkspaceIdentity } from '@podium/identity'
import { asUserId } from '@podium/model'
import { RevokeDeviceSignInRequest } from '@podium/protocol'
import type { Context, Hono } from 'hono'
import { ADMIN_PAGE_LIMIT } from './admin-routes'
import { isAllowedHttpOrigin } from './http-cors'
import { type MemberOfRequest, refusalAnswer } from './identity/member-of-request'
import type { SettingsAuditRepository } from './store/settings-audit'

const DEVICE_NAMES = {
  browser: 'Web browser',
  desktop: 'Podium desktop',
  phone: 'Phone',
  host: 'Host recovery session',
} as const

export function publicSignIn(signIn: DeviceSignIn) {
  const { id, kind, deviceName, platform, createdAt, lastSeenAt, expiresAt, current } = signIn
  return {
    id,
    kind,
    deviceName: deviceName || DEVICE_NAMES[kind],
    platform,
    createdAt: createdAt.toISOString(),
    lastSeenAt: lastSeenAt?.toISOString() ?? null,
    expiresAt: expiresAt.toISOString(),
    current,
  }
}

export function registerSignInRoutes(
  app: Hono,
  opts: {
    identity: WorkspaceIdentity
    memberOfRequest: MemberOfRequest
    audit: SettingsAuditRepository
    onDeviceSignInEnded?: (id: string) => void
    allowedOrigins?: ReadonlySet<string>
  },
): void {
  const { identity, memberOfRequest } = opts
  const { core } = identity
  const rejectForeignOrigin = (c: Context) => {
    c.header('cache-control', 'no-store')
    const origin = c.req.header('origin')
    return (
      origin !== undefined &&
      !isAllowedHttpOrigin(origin, new URL(c.req.url).host, opts.allowedOrigins)
    )
  }
  const callerWithDevice = async (c: Context) => {
    const caller = await memberOfRequest(c.req.raw)
    if (caller.kind !== 'member') {
      const refusal = refusalAnswer(caller)
      return c.json(refusal.body, refusal.status)
    }
    if (!caller.deviceSignIn) return c.json({ error: 'authentication required' }, 401)
    return { accountId: caller.accountId, deviceSignInId: caller.deviceSignIn.id }
  }

  app.get('/auth/client-sessions', async (c) => {
    if (rejectForeignOrigin(c)) return c.json({ error: 'Origin refused' }, 403)
    const caller = await callerWithDevice(c)
    if (caller instanceof Response) return caller
    const signIns = await core.deviceSignIns.listForAccount(caller.accountId, caller.deviceSignInId)
    return c.json({ signIns: signIns.map(publicSignIn) })
  })

  app.post('/auth/client-sessions/revoke', async (c) => {
    if (rejectForeignOrigin(c)) return c.json({ error: 'Origin refused' }, 403)
    const caller = await callerWithDevice(c)
    if (caller instanceof Response) return caller
    const input = RevokeDeviceSignInRequest.safeParse(await c.req.json().catch(() => undefined))
    if (!input.success) return c.json({ error: 'session not found' }, 404)
    const { id } = input.data
    const { revoked } = await core.deviceSignIns.revoke(id, { byAccount: caller.accountId })
    if (!revoked) return c.json({ error: 'session not found' }, 404)
    opts.onDeviceSignInEnded?.(id)
    // A cookie caller that signs this device out should also clear its cookie.
    // A bearer caller may carry a different cookie, which must be left alone.
    if (id === caller.deviceSignInId && !c.req.header('authorization')) {
      const { headers } = await core.signIn.signOut(c.req.raw, memberOfRequest.factsOf(c.req.raw))
      for (const cookie of headers.getSetCookie()) c.header('set-cookie', cookie, { append: true })
    }
    return c.json({ ok: true })
  })

  app.get('/auth/admin/sign-ins', async (c) => {
    if (rejectForeignOrigin(c)) return c.json({ error: 'Origin refused' }, 403)
    const caller = await memberOfRequest(c.req.raw)
    if (caller.kind !== 'member' || caller.role !== 'admin') {
      return c.json({ error: 'Administrator access required' }, 403)
    }
    const { signIns, total } = await identity.listDeviceSignIns({ limit: ADMIN_PAGE_LIMIT })
    return c.json({
      signIns: signIns.map((row) => ({
        ...publicSignIn(row),
        memberId: row.memberId,
        memberName: row.memberName,
      })),
      signInsTotal: total,
    })
  })

  app.post('/auth/admin/sign-ins/revoke', async (c) => {
    if (rejectForeignOrigin(c)) return c.json({ error: 'Origin refused' }, 403)
    const caller = await memberOfRequest(c.req.raw)
    if (
      !core.capabilities().adminEndDeviceSignIn ||
      caller.kind !== 'member' ||
      caller.role !== 'admin' ||
      !caller.deviceSignIn
    ) {
      return c.json({ error: 'Administrator access required' }, 403)
    }
    const input = RevokeDeviceSignInRequest.safeParse(await c.req.json().catch(() => undefined))
    if (!input.success) return c.json({ error: 'session not found' }, 404)
    const { id } = input.data
    const deviceSignInId = caller.deviceSignIn.id
    const result = await core.transaction(async () => {
      if (
        !(await identity.revalidate({ deviceSignInId, memberId: caller.memberId, role: 'admin' }))
      ) {
        return 'refused'
      }
      const owner = await identity.deviceSignInOwner(id)
      if (!owner) return 'missing'
      const { revoked } = await core.deviceSignIns.revoke(id, { byAccount: owner.accountId })
      if (!revoked) return 'missing'
      await opts.audit.append({
        command: 'members.revokeSignIn',
        outcome: 'applied',
        actorKind: 'user',
        actorId: caller.memberId,
        onBehalfOf: caller.memberId,
        detail: { memberId: asUserId(owner.memberId) },
        redactedPaths: [],
        createdAt: new Date().toISOString(),
      })
      return 'revoked'
    })
    if (result === 'refused') return c.json({ error: 'Administrator access required' }, 403)
    if (result === 'missing') return c.json({ error: 'session not found' }, 404)
    opts.onDeviceSignInEnded?.(id)
    return c.json({ ok: true })
  })
}
