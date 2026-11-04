import { asUserId, LoginEmail, type UserId } from '@podium/model'
import { SESSION_COOKIE } from '@podium/protocol'
import { verifyPasswordHash } from '@podium/runtime/auth-store'
import { type Context, Hono } from 'hono'
import { deleteCookie } from 'hono/cookie'
import { z } from 'zod'
import { isAllowedHttpOrigin } from './http-cors'
import { CreateMemberInvite, InvitePassword, type MemberInvites } from './member-invites'
import { MemberChangeRefused, type UsersRepository } from './store/users'

export type MemberInviteMail = (message: {
  email: string
  url: string
  expiresAt: string
}) => Promise<void>

/** A password-reset link, mailed to the member who asked for it (POD-6298). */
export type MemberRecoveryMail = (message: {
  email: string
  url: string
  expiresAt: string
}) => Promise<void>

/** The refusal a client answers by asking for the current password again. */
export const REAUTH_REQUIRED = 'reauth_required'

const MemberTarget = z.object({ id: z.string().min(1), current: z.string().max(1024).optional() })

/** What an admin may do to one member, as the People section offers it (POD-6299). */
export const MEMBER_ACTIONS = [
  'setRole',
  'disable',
  'enable',
  'remove',
  'recovery',
  'invite',
  'signOutEverywhere',
] as const
export type MemberAction = (typeof MEMBER_ACTIONS)[number]

/**
 * THE ALLOWED ACTIONS PER MEMBER, decided here so the client draws only what
 * the server would accept (POD-6299). A rendering hint, not authority: every
 * route re-checks at apply time, and a concurrent change can still be refused
 * (the last admin, a stale role). An admin acts on themselves only to sign out
 * everywhere; the last active admin cannot be demoted, disabled or removed.
 */
export function memberActions(
  members: readonly {
    id: string
    role: string
    disabledAt: string | null
    accountId?: string | null
  }[],
  actor: UserId,
  withPassword: ReadonlySet<UserId>,
): Record<string, MemberAction[]> {
  const activeAdmins = members.filter((m) => m.role === 'admin' && !m.disabledAt).length
  const actions: Record<string, MemberAction[]> = {}
  for (const member of members) {
    const id = member.id as UserId
    if (id === actor) {
      actions[id] = ['signOutEverywhere']
      continue
    }
    if (member.disabledAt) {
      actions[id] = ['enable', 'remove']
      continue
    }
    const lastAdmin = member.role === 'admin' && activeAdmins <= 1
    actions[id] = [
      ...(lastAdmin ? [] : (['setRole', 'disable', 'remove'] as const)),
      ...(withPassword.has(id) ? (['recovery'] as const) : []),
      ...(!withPassword.has(id) && !member.accountId ? (['invite'] as const) : []),
      'signOutEverywhere',
    ]
  }
  return actions
}

export function registerMemberRoutes(
  app: Hono,
  options: {
    users: UsersRepository
    invites: MemberInvites
    resolveUserId: (request: Request) => Promise<UserId | undefined>
    appUrl: () => string | undefined
    allowedOrigins?: ReadonlySet<string>
    sendMail?: MemberInviteMail
    /** Present when this instance can mail a password reset to a member. */
    sendRecoveryMail?: MemberRecoveryMail
  },
) {
  const routes = new Hono()
  routes.onError((error, c) => {
    if (error instanceof MemberChangeRefused) {
      const status = { 'admin-required': 403, 'last-admin': 409, self: 409, unavailable: 404 }[
        error.code
      ] as 403 | 409 | 404
      return c.json({ error: error.message, code: error.code }, status)
    }
    return c.json(
      {
        error:
          error instanceof z.ZodError
            ? 'Invalid invite details'
            : 'Unable to change membership or invite',
      },
      400,
    )
  })
  const { users, invites } = options
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    const origin = c.req.header('origin')
    if (origin && !isAllowedHttpOrigin(origin, new URL(c.req.url).host, options.allowedOrigins))
      return c.json({ error: 'Origin refused' }, 403)
    await next()
  })
  const admin = async (request: Request) => {
    const actor = await options.resolveUserId(request)
    return actor && (await users.roleOf(actor)) === 'admin' ? actor : undefined
  }
  /**
   * RECENT AUTHENTICATION FOR ROLE AND CREDENTIAL CHANGES (POD-6298): the
   * acting member's current password, verified on this request, the way
   * `auth.setPassword` and `auth.setLoginRequired` already confirm theirs. A
   * stolen session cookie alone cannot promote, disable, remove or reset
   * anyone. A member with no password (a hosted account, open-mode bootstrap)
   * has nothing to confirm with and passes, as `auth.setPassword` does.
   */
  const confirmed = async (actor: UserId, current: string | undefined) => {
    const credential = await users.credentialFor(actor)
    if (!credential?.passwordHash) return true
    return current !== undefined && (await verifyPasswordHash(current, credential.passwordHash))
  }
  const reauthRequired = (c: Context) =>
    c.json({ error: 'Confirm with your current password', code: REAUTH_REQUIRED }, 403)
  /** An admin, who has just confirmed their password, acting on member `id`. */
  const confirmedAdmin = async (c: Context) => {
    const actor = await admin(c.req.raw)
    if (!actor) return { refusal: c.json({ error: 'Administrator required' }, 403) }
    const body = MemberTarget.passthrough().parse(await c.req.json())
    if (!(await confirmed(actor, body.current))) return { refusal: reauthRequired(c) }
    return { actor, body, target: asUserId(body.id) }
  }
  routes.get('/list', async (c) => {
    const actor = await admin(c.req.raw)
    if (!actor) return c.json({ error: 'Administrator required' }, 403)
    // Disabled and removed members too: they are the ones to enable or re-invite.
    const members = await users.listIncludingDisabled()
    return c.json({
      members,
      invites: await invites.list(actor),
      mailAvailable: Boolean(options.sendMail),
      currentMemberId: actor,
      actions: memberActions(members, actor, await users.membersWithPassword()),
    })
  })
  /**
   * THE MEMBER DIRECTORY (POD-6294; design §4.1, "members read what the UI
   * needs"). Every signed-in member reads who else is on the instance, so task
   * views can name an assignee and offer the members to assign or filter by.
   * Names, roles and the disabled mark only: another member's email stays with
   * the admins (MU-13), who get the same rows `/list` gives them. The rows are
   * the active members `users.list()` answers; a disabled member is not listed.
   */
  routes.get('/directory', async (c) => {
    const actor = await options.resolveUserId(c.req.raw)
    const self = actor ? await users.get(actor) : undefined
    if (!actor || !self || self.disabledAt) return c.json({ error: 'Sign in required' }, 401)
    const members = (await users.list()).map((member) =>
      self.role === 'admin' || member.id === actor ? member : { ...member, email: null },
    )
    return c.json({ members, currentMemberId: actor })
  })
  routes.post('/invite', async (c) => {
    const actor = await admin(c.req.raw)
    if (!actor) return c.json({ error: 'Administrator required' }, 403)
    const { current, ...data } = CreateMemberInvite.extend({
      sendEmail: z.boolean().default(false),
      current: z.string().max(1024).optional(),
    }).parse(await c.req.json())
    // Inviting an admin grants a role: it needs the same confirmation as a role change.
    if (data.role === 'admin' && !(await confirmed(actor, current))) return reauthRequired(c)
    if (data.sendEmail && (!options.sendMail || !data.email))
      return c.json({ error: 'Email delivery unavailable' }, 400)
    const invite = await invites.create(actor, data)
    const url = linkFor(c, invite.token)
    let mailSent = false
    if (data.sendEmail && options.sendMail && invite.email) {
      try {
        await options.sendMail({ email: invite.email, url: url.href, expiresAt: invite.expiresAt })
        mailSent = true
      } catch {
        /* The admin still gets the usable link. */
      }
    }
    return c.json({ invite, url: url.href, mailSent })
  })
  routes.post('/revoke', async (c) => {
    const actor = await admin(c.req.raw)
    if (!actor) return c.json({ error: 'Administrator required' }, 403)
    const { id } = z.object({ id: z.string() }).parse(await c.req.json())
    await invites.revoke(actor, id)
    return c.json({ ok: true })
  })
  // Removal releases custody and ends the member's sign-ins and password; their
  // history stays theirs (design §2.1, MU-14). Nothing else is offboarded.
  routes.post('/remove', async (c) => {
    const change = await confirmedAdmin(c)
    if ('refusal' in change) return change.refusal
    await users.removeMember(change.target, change.actor)
    return c.json({ ok: true })
  })
  routes.post('/role', async (c) => {
    const change = await confirmedAdmin(c)
    if ('refusal' in change) return change.refusal
    const { role } = z.object({ role: z.enum(['admin', 'member']) }).parse(change.body)
    await users.setRole(change.target, role, change.actor)
    return c.json({ ok: true })
  })
  routes.post('/disable', async (c) => {
    const change = await confirmedAdmin(c)
    if ('refusal' in change) return change.refusal
    await users.disable(change.target, new Date().toISOString(), change.actor)
    return c.json({ ok: true })
  })
  routes.post('/enable', async (c) => {
    const change = await confirmedAdmin(c)
    if ('refusal' in change) return change.refusal
    await users.enable(change.target, new Date().toISOString(), change.actor)
    return c.json({ ok: true })
  })
  /** An admin-issued recovery link for a member who has a password (design §2.1). */
  routes.post('/recovery', async (c) => {
    const change = await confirmedAdmin(c)
    if ('refusal' in change) return change.refusal
    const invite = await invites.createRecovery(change.actor, change.target)
    return c.json({ invite, url: linkFor(c, invite.token).href })
  })
  /** Whether "forgot password" can mail a reset here; otherwise an admin or the host. */
  routes.get('/recovery-options', (c) => c.json({ mailReset: Boolean(options.sendRecoveryMail) }))
  routes.post('/reset-request', async (c) => {
    if (!options.sendRecoveryMail) {
      return c.json(
        {
          error:
            'Password reset by email is not available here. Ask an administrator for a recovery link.',
        },
        404,
      )
    }
    const { email } = z.object({ email: z.string().max(254) }).parse(await c.req.json())
    const invite = await invites.requestMailedReset(email)
    if (invite?.email) {
      try {
        await options.sendRecoveryMail({
          email: invite.email,
          url: linkFor(c, invite.token).href,
          expiresAt: invite.expiresAt,
        })
      } catch {
        /* The same answer either way: the caller learns nothing about the address. */
      }
    }
    return c.json({ ok: true })
  })
  /**
   * SIGN OUT EVERYWHERE (POD-6298, over POD-6293's transaction): every sign-in
   * of the member ends and their open connections close at the commit. A
   * member signs themselves out; an admin may sign out anyone. One device is
   * `/auth/logout`, or `/auth/client-sessions/revoke` for a paired phone.
   */
  routes.post('/sign-out-everywhere', async (c) => {
    const actor = await options.resolveUserId(c.req.raw)
    if (!actor || !(await users.get(actor))) return c.json({ error: 'Sign in required' }, 401)
    const { id } = z
      .object({ id: z.string().min(1).optional() })
      .parse(await c.req.json().catch(() => ({})))
    const target = id ? asUserId(id) : actor
    if (target !== actor && (await users.roleOf(actor)) !== 'admin')
      return c.json({ error: 'Administrator required' }, 403)
    await users.signOutEverywhere(target, actor)
    if (target === actor) deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })
  routes.post('/inspect', async (c) => {
    const { token } = z.object({ token: z.string().max(100) }).parse(await c.req.json())
    return c.json(await invites.inspect(token))
  })
  routes.post('/complete', async (c) => {
    const body = z
      .object({
        token: z.string().max(100),
        email: LoginEmail,
        password: InvitePassword,
        displayName: z.string().trim().min(1).max(200),
      })
      .strict()
      .parse(await c.req.json())
    const member = await invites.complete({
      token: body.token,
      identity: { kind: 'password', ...body },
    })
    return c.json({ userId: member.id })
  })
  /** The link a token travels in. The fragment keeps the bearer token out of
   *  server access logs and referrers. */
  function linkFor(c: Context, token: string): URL {
    const origin = c.req.header('origin')
    const browserOrigin = origin && /^https?:\/\//.test(origin) ? origin : undefined
    const url = new URL(options.appUrl() || browserOrigin || new URL(c.req.url).origin)
    url.hash = `invite=${token}`
    return url
  }
  app.route('/auth/members', routes)
}
