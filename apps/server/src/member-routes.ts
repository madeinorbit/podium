import { asUserId, LoginEmail, type UserId } from '@podium/model'
import { Hono } from 'hono'
import { z } from 'zod'
import { isAllowedHttpOrigin } from './http-cors'
import { CreateMemberInvite, InvitePassword, MemberInvites } from './member-invites'
import type { UsersRepository } from './store/users'

export type MemberInviteMail = (message: {
  email: string
  url: string
  expiresAt: string
}) => Promise<void>

export function registerMemberRoutes(
  app: Hono,
  options: {
    users: UsersRepository
    invites: MemberInvites
    resolveUserId: (request: Request) => Promise<UserId | undefined>
    appUrl: () => string | undefined
    allowedOrigins?: ReadonlySet<string>
    sendMail?: MemberInviteMail
  },
) {
  const routes = new Hono()
  routes.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof z.ZodError
            ? 'Invalid invite details'
            : 'Unable to change membership or invite',
      },
      400,
    ),
  )
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
  routes.get('/list', async (c) => {
    const actor = await admin(c.req.raw)
    if (!actor) return c.json({ error: 'Administrator required' }, 403)
    return c.json({
      members: await users.list(),
      invites: await invites.list(actor),
      mailAvailable: Boolean(options.sendMail),
      currentMemberId: actor,
    })
  })
  routes.post('/invite', async (c) => {
    const actor = await admin(c.req.raw)
    if (!actor) return c.json({ error: 'Administrator required' }, 403)
    const data = CreateMemberInvite.extend({ sendEmail: z.boolean().default(false) }).parse(
      await c.req.json(),
    )
    if (data.sendEmail && (!options.sendMail || !data.email))
      return c.json({ error: 'Email delivery unavailable' }, 400)
    const invite = await invites.create(actor, data)
    // Fragment keeps the bearer invite token out of server access logs and referrers.
    const origin = c.req.header('origin')
    const browserOrigin = origin && /^https?:\/\//.test(origin) ? origin : undefined
    const url = new URL(options.appUrl() || browserOrigin || new URL(c.req.url).origin)
    url.hash = `invite=${invite.token}`
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
  routes.post('/remove', async (c) => {
    const actor = await admin(c.req.raw)
    if (!actor) return c.json({ error: 'Administrator required' }, 403)
    const { id } = z.object({ id: z.string() }).parse(await c.req.json())
    await users.removeMember(asUserId(id), actor)
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
  app.route('/auth/members', routes)
}
