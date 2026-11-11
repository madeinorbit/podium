import {
  type Capabilities,
  MembershipRefused,
  type MembershipView,
  type WorkspaceIdentity,
} from '@podium/identity'
import { asUserId, LoginEmail, type UserId } from '@podium/model'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { isAllowedHttpOrigin } from './http-cors'
import { CreateMemberInvite, InvitePassword, memberLinks } from './member-invites'
import type { UsersRepository } from './store/users'

export const REAUTH_REQUIRED = 'reauth_required'
const MemberTarget = z.object({ id: z.string().min(1), current: z.string().max(1024).optional() })
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

/** A hint only: membership operations recheck every rule inside their transaction. */
export function memberActions(
  members: readonly MembershipView[],
  actor: string,
  capabilities: Capabilities,
): Record<string, MemberAction[]> {
  const activeAdmins = members.filter((m) => m.status === 'active' && m.role === 'admin').length
  return Object.fromEntries(
    members.map((member) => {
      const actions: MemberAction[] = []
      if (member.memberId === actor) actions.push('signOutEverywhere')
      else if (member.status === 'disabled')
        actions.push(
          ...(member.account ? ['enable' as const, 'remove' as const] : ['invite' as const]),
        )
      else if (member.status === 'removed' || member.status === 'invited') actions.push('invite')
      else {
        if (member.role !== 'admin' || activeAdmins > 1)
          actions.push('setRole', 'disable', 'remove')
        if (member.hasPassword && capabilities.passwordReset === 'admin-link')
          actions.push('recovery')
        if (capabilities.adminSignOutEverywhere) actions.push('signOutEverywhere')
      }
      return [member.memberId, actions]
    }),
  )
}

export function registerMemberRoutes(
  app: Hono,
  options: {
    users: UsersRepository
    identity: WorkspaceIdentity
    resolveUserId: (request: Request) => Promise<UserId | undefined>
    appUrl: () => string | undefined
    allowedOrigins?: ReadonlySet<string>
    onDeviceSignInEnded?: (id: string) => void
    onMembershipChanged?: (memberId: string) => void
  },
) {
  const { users, identity } = options
  const { core, memberships } = identity
  const links = memberLinks(options)
  const routes = new Hono()
  routes.onError((error, c) => {
    if (error instanceof MembershipRefused) {
      const status =
        error.code === 'admin-required'
          ? 403
          : error.code === 'last-admin' || error.code === 'self'
            ? 409
            : error.code === 'unavailable'
              ? 404
              : error.code === 'not-allowed'
                ? 403
                : 400
      const messages: Partial<Record<MembershipRefused['code'], string>> = {
        'last-admin': 'The last administrator cannot be demoted, disabled or removed',
        'admin-required': 'Administrator required',
        self: 'You cannot disable or remove yourself',
        unavailable: 'Member unavailable',
        'email-mismatch': 'Use the invited email',
        'not-allowed': 'This action is unavailable for this membership',
        'invitation-invalid': 'Link is invalid or no longer available',
      }
      return c.json(
        { error: messages[error.code] ?? 'Membership change refused', code: error.code },
        status,
      )
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
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    const origin = c.req.header('origin')
    if (origin && !isAllowedHttpOrigin(origin, new URL(c.req.url).host, options.allowedOrigins))
      return c.json({ error: 'Origin refused' }, 403)
    await next()
  })
  const actorMembership = async (request: Request) => {
    const id = await options.resolveUserId(request)
    if (!id) return undefined
    return (await memberships.list()).find((m) => m.memberId === id && m.status === 'active')
  }
  const admin = async (request: Request) => {
    const member = await actorMembership(request)
    return member?.role === 'admin' ? member : undefined
  }
  const confirmed = async (member: MembershipView, current: string | undefined) =>
    !member.hasPassword ||
    Boolean(
      member.account &&
        current !== undefined &&
        (await core.accounts.verifyPassword(member.account.id, current)),
    )
  const reauthRequired = (c: Context) =>
    c.json({ error: 'Confirm with your current password', code: REAUTH_REQUIRED }, 403)
  const confirmedAdmin = async (c: Context) => {
    const actor = await admin(c.req.raw)
    if (!actor) return { refusal: c.json({ error: 'Administrator required' }, 403) }
    const body = MemberTarget.passthrough().parse(await c.req.json())
    if (!(await confirmed(actor, body.current))) return { refusal: reauthRequired(c) }
    return { actor: { memberId: actor.memberId }, body, target: body.id }
  }
  routes.get('/list', async (c) => {
    const actor = await admin(c.req.raw)
    if (!actor) return c.json({ error: 'Administrator required' }, 403)
    const members = await memberships.list()
    const rows = new Map(
      (await users.listIncludingDisabled()).map((row) => [row.id as string, row]),
    )
    return c.json({
      members: members.map((m) => ({
        ...m,
        id: m.memberId,
        displayName: m.account?.name ?? rows.get(m.memberId)?.displayName ?? 'Member',
        email: m.account?.email ?? m.invitedEmail,
        accountId: m.account?.id ?? null,
        avatar: m.account?.image ?? null,
        disabledAt:
          m.status === 'disabled' || m.status === 'removed'
            ? (rows.get(m.memberId)?.disabledAt ?? null)
            : null,
      })),
      invites: members.flatMap((m) =>
        m.pendingInvitation
          ? [{ ...m.pendingInvitation, memberId: m.memberId, email: m.invitedEmail, role: m.role }]
          : [],
      ),
      currentMemberId: actor.memberId,
      hasOwnCredential: actor.hasPassword,
      actions: memberActions(members, actor.memberId, core.capabilities()),
    })
  })
  routes.get('/directory', async (c) => {
    const actor = await options.resolveUserId(c.req.raw)
    const self = actor ? await users.get(actor) : undefined
    if (!actor || !self || self.disabledAt) return c.json({ error: 'Sign in required' }, 401)
    const members = (await users.list()).map(({ id, displayName, role }) => ({
      id,
      displayName,
      role,
    }))
    return c.json({ members, currentMemberId: actor })
  })
  routes.post('/invite', async (c) => {
    const actor = await admin(c.req.raw)
    if (!actor) return c.json({ error: 'Administrator required' }, 403)
    const { current, ...data } = CreateMemberInvite.extend({
      current: z.string().max(1024).optional(),
    }).parse(await c.req.json())
    if (data.role === 'admin' && !(await confirmed(actor, current))) return reauthRequired(c)
    const result = await memberships.invite({ actor: { memberId: actor.memberId }, ...data })
    const invite = {
      ...result.invitation,
      memberId: result.membership.memberId,
      email: result.membership.invitedEmail,
      role: result.membership.role,
    }
    await users.audit('members.invite', asUserId(actor.memberId), {
      inviteId: invite.id,
      memberId: invite.memberId,
      role: invite.role,
    })
    return c.json({ invite, url: linkFor(c, invite.token).href, mailSent: result.mailed })
  })
  routes.post('/revoke', async (c) => {
    const actor = await admin(c.req.raw)
    if (!actor) return c.json({ error: 'Administrator required' }, 403)
    const { id } = z.object({ id: z.string().min(1) }).parse(await c.req.json())
    await memberships.revokeInvitation({ actor: { memberId: actor.memberId }, invitationId: id })
    await users.audit('members.inviteRevoked', asUserId(actor.memberId), { inviteId: id })
    return c.json({ ok: true })
  })
  for (const action of ['remove', 'disable', 'enable'] as const)
    routes.post(`/${action}`, async (c) => {
      const change = await confirmedAdmin(c)
      if ('refusal' in change) return change.refusal
      await memberships[action]({ actor: change.actor, memberId: change.target })
      options.onMembershipChanged?.(change.target)
      return c.json({ ok: true })
    })
  routes.post('/role', async (c) => {
    const change = await confirmedAdmin(c)
    if ('refusal' in change) return change.refusal
    const { role } = z.object({ role: z.enum(['admin', 'member']) }).parse(change.body)
    await memberships.setRole({ actor: change.actor, memberId: change.target, role })
    options.onMembershipChanged?.(change.target)
    return c.json({ ok: true })
  })
  routes.post('/recovery', async (c) => {
    const change = await confirmedAdmin(c)
    if ('refusal' in change) return change.refusal
    const invite = await links.createRecovery(asUserId(change.actor.memberId), change.target)
    return c.json({ invite, url: linkFor(c, invite.token).href })
  })
  routes.post('/sign-out-everywhere', async (c) => {
    const actor = await actorMembership(c.req.raw)
    if (!actor?.account) return c.json({ error: 'Sign in required' }, 401)
    const { id } = z
      .object({ id: z.string().min(1).optional() })
      .parse(await c.req.json().catch(() => ({})))
    const target = id ?? actor.memberId
    if (
      target !== actor.memberId &&
      (actor.role !== 'admin' || !core.capabilities().adminSignOutEverywhere)
    )
      return c.json({ error: 'Administrator required' }, 403)
    const ended = await core.transaction(async () => {
      const current = await actorMembership(c.req.raw)
      if (!current || (target !== current.memberId && current.role !== 'admin'))
        throw new MembershipRefused('admin-required')
      const member = (await memberships.list()).find(
        (m) => m.memberId === target && (m.status === 'active' || m.status === 'disabled'),
      )
      if (!member?.account) throw new MembershipRefused('unavailable')
      const ids = await core.deviceSignIns.revokeAllForAccount(member.account.id)
      // Sign-ins from before shared sign-in end with them (POD-6751, R16).
      await users.endOldSignIns(asUserId(target))
      await users.audit('members.signOut', asUserId(actor.memberId), { memberId: target })
      return ids
    })
    for (const id of ended) options.onDeviceSignInEnded?.(id)
    return c.json({ ok: true })
  })
  routes.post('/inspect', async (c) => {
    const { token } = z.object({ token: z.string().max(100) }).parse(await c.req.json())
    return c.json(await links.inspect(token))
  })
  routes.post('/complete', async (c) => {
    const body = z
      .object({
        token: z.string().max(100),
        email: LoginEmail.optional(),
        password: InvitePassword,
        displayName: z.string().trim().min(1).max(200).optional(),
      })
      .strict()
      .parse(await c.req.json())
    return c.json(await links.complete(body))
  })
  function linkFor(c: Context, token: string): URL {
    const origin = c.req.header('origin')
    const browserOrigin = origin && /^https?:\/\//.test(origin) ? origin : undefined
    const url = new URL(options.appUrl() || browserOrigin || new URL(c.req.url).origin)
    url.hash = `invite=${token}`
    return url
  }
  app.route('/auth/members', routes)
}
