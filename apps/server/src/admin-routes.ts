/**
 * THE ADMINISTRATION AREA'S READS (POD-6299; design §2.6).
 *
 * The admin area has five sections: People, Access, Machines, Instance and
 * Audit. People reuses `/auth/members/*` and Machines the fleet commands; this
 * module adds what had no route:
 *
 * - `GET /auth/admin/viewer`: which sections the caller may open. Any
 *   signed-in member asks; a member who is not an admin gets none, and the
 *   client draws no admin area from that answer.
 * - `GET /auth/admin/access`: how people are admitted and every unexpired
 *   sign-in, by member and device. No token or token hash leaves.
 * - `GET /auth/admin/audit`: the security events, newest first, as actor,
 *   delegated human, target, result and time. A stored row's detail is never
 *   sent as it is: only the ids and the few fields named in
 *   {@link projectSecurityEvent} are read out of it, so a preference value, a
 *   secret or any task or transcript text cannot reach the page.
 *
 * Access and Audit refuse anyone but an enabled admin with 403.
 */

import type { UserId, UserRole } from '@podium/model'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { isAllowedHttpOrigin } from './http-cors'
import type { AuthRepository } from './store/auth'
import type { SecurityEventRow, SettingsAuditRepository } from './store/settings-audit'
import type { UsersRepository } from './store/users'

/** The admin area's sections, in the order the client shows them. */
export const ADMIN_SECTIONS = ['people', 'access', 'machines', 'instance', 'audit'] as const
export type AdminSection = (typeof ADMIN_SECTIONS)[number]

/** How many sign-ins and events one answer carries at most. */
export const ADMIN_PAGE_LIMIT = 200

/** One named party in an event: a member, an agent session, the system. */
export interface AuditParty {
  kind: 'member' | 'agent' | 'machine' | 'system'
  id: string | null
  name: string
}

/** What an event acted on. */
export interface AuditTarget {
  kind: 'member' | 'machine' | 'invite' | 'secret' | 'task' | 'instance'
  id: string | null
  name: string
}

export interface SecurityEvent {
  id: number
  at: string
  command: string
  result: 'applied' | 'refused'
  actor: AuditParty
  /** The human the actor acted for; for a member acting directly, the member. */
  onBehalfOf: AuditParty | null
  target: AuditTarget | null
  /** Short, safe facts: a role change's roles, a custody change's members. */
  facts: Record<string, string>
}

interface Names {
  members: ReadonlyMap<string, string>
  machines: ReadonlyMap<string, string>
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

function memberParty(id: string | null, names: Names): AuditParty | null {
  if (!id) return null
  return { kind: 'member', id, name: names.members.get(id) ?? 'Removed member' }
}

/**
 * One stored row as the admin area shows it. Exported so the projection is
 * testable without a database: whatever a row's detail holds, only the keys
 * read below can come out, and only as ids, names, roles or a secret's KEY.
 */
export function projectSecurityEvent(row: SecurityEventRow, names: Names): SecurityEvent {
  const detail =
    row.detail && typeof row.detail === 'object' ? (row.detail as Record<string, unknown>) : {}
  const input =
    detail.input && typeof detail.input === 'object'
      ? (detail.input as Record<string, unknown>)
      : {}
  const actor: AuditParty =
    row.actorKind === 'user'
      ? (memberParty(row.actorId, names) ?? { kind: 'member', id: null, name: 'A member' })
      : row.actorKind === 'agent'
        ? { kind: 'agent', id: row.actorId, name: 'An agent' }
        : row.actorKind === 'machine'
          ? { kind: 'machine', id: row.actorId, name: 'A machine' }
          : { kind: 'system', id: null, name: detail.by === 'host' ? 'This host' : 'Podium' }
  const facts: Record<string, string> = {}
  const role = (key: string) => {
    const value = text(detail[key])
    if (value === 'admin' || value === 'member') facts[key] = value
  }
  role('from')
  role('to')
  role('role')
  for (const key of ['previousOwnerUserId', 'newOwnerUserId'] as const) {
    const id = text(detail[key])
    const fact = key === 'previousOwnerUserId' ? 'previousOwner' : 'newOwner'
    if (id) facts[fact] = names.members.get(id) ?? 'Removed member'
    else if (key in detail) facts[fact] = 'Nobody'
  }
  let target: AuditTarget | null = null
  const machineId = text(detail.machineId)
  const memberId = text(detail.memberId)
  const inviteId = text(detail.inviteId)
  if (row.command === 'settings.setSecret' || row.command === 'settings.clearSecret') {
    // The secret's KEY names which one; its value was never stored here.
    target = { kind: 'secret', id: null, name: text(input.key) ?? 'A secret' }
  } else if (row.command === 'issues.editComment' || row.command === 'issues.deleteComment') {
    target = { kind: 'task', id: text(detail.issueId) ?? null, name: 'A comment' }
  } else if (machineId) {
    target = { kind: 'machine', id: machineId, name: names.machines.get(machineId) ?? machineId }
  } else if (memberId) {
    target = memberParty(memberId, names) as AuditTarget
  } else if (inviteId) {
    target = { kind: 'invite', id: inviteId, name: 'An invitation' }
  }
  return {
    id: row.id,
    at: row.createdAt,
    command: row.command,
    result: row.outcome,
    actor,
    // A system row has no human by construction (ADR 9 D8 S5).
    onBehalfOf: row.actorKind === 'system' ? null : memberParty(row.onBehalfOf, names),
    target,
    facts,
  }
}

export function registerAdminRoutes(
  app: Hono,
  options: {
    users: UsersRepository
    auth: AuthRepository
    audit: SettingsAuditRepository
    /** Names of the machines an event names, in one read. */
    machineNames: (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>
    resolveUserId: (request: Request) => Promise<UserId | undefined>
    loginRequired: () => Promise<boolean>
    allowedOrigins?: ReadonlySet<string>
    now?: () => number
  },
) {
  const { users } = options
  const now = options.now ?? (() => Date.now())
  const routes = new Hono()
  routes.onError((error, c) =>
    c.json(
      { error: error instanceof z.ZodError ? 'Invalid request' : 'Unable to read this section' },
      400,
    ),
  )
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    const origin = c.req.header('origin')
    if (origin && !isAllowedHttpOrigin(origin, new URL(c.req.url).host, options.allowedOrigins))
      return c.json({ error: 'Origin refused' }, 403)
    await next()
  })
  /** The enabled member asking, with their role; undefined when nobody is signed in. */
  const caller = async (c: Context): Promise<{ id: UserId; role: UserRole } | undefined> => {
    const id = await options.resolveUserId(c.req.raw)
    const member = id ? await users.get(id) : undefined
    return id && member && !member.disabledAt ? { id, role: member.role } : undefined
  }
  const adminRequired = (c: Context) => c.json({ error: 'Administrator required' }, 403)

  routes.get('/viewer', async (c) => {
    const who = await caller(c)
    if (!who) return c.json({ error: 'Sign in required' }, 401)
    return c.json({ sections: who.role === 'admin' ? [...ADMIN_SECTIONS] : [] })
  })

  routes.get('/access', async (c) => {
    const who = await caller(c)
    if (who?.role !== 'admin') return adminRequired(c)
    const at = now()
    const [members, invites, signIns, signInRequired] = await Promise.all([
      users.listIncludingDisabled(),
      users.pendingInvites(),
      options.auth.listUnexpiredSignIns(new Date(at).toISOString(), ADMIN_PAGE_LIMIT),
      options.loginRequired(),
    ])
    const names = new Map(members.map((m) => [m.id as string, m.displayName]))
    const open = invites.filter((invite) => Date.parse(invite.expiresAt) > at)
    return c.json({
      admission: {
        // Invitation only (design §2.1, D8); self-registration is not offered.
        mode: 'invitation' as const,
        signInRequired,
        openInvites: open.length,
        expiredInvites: invites.length - open.length,
        activeMembers: members.filter((m) => !m.disabledAt).length,
        disabledMembers: members.filter((m) => m.disabledAt).length,
      },
      signIns: signIns.map((row) => ({
        memberId: row.userId,
        memberName: names.get(row.userId) ?? 'Removed member',
        kind: row.label,
        deviceName: row.deviceName,
        platform: row.platform,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        expiresAt: row.expiresAt,
      })),
    })
  })

  routes.get('/audit', async (c) => {
    const who = await caller(c)
    if (who?.role !== 'admin') return adminRequired(c)
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(ADMIN_PAGE_LIMIT).default(100),
        before: z.coerce.number().int().min(1).optional(),
      })
      .parse({ limit: c.req.query('limit'), before: c.req.query('before') })
    const rows = await options.audit.securityEvents(query.limit, query.before)
    const machineIds = [
      ...new Set(
        rows.flatMap((row) => {
          const id = (row.detail as { machineId?: unknown } | null)?.machineId
          return typeof id === 'string' ? [id] : []
        }),
      ),
    ]
    const [members, machines] = await Promise.all([
      users.listIncludingDisabled(),
      machineIds.length > 0 ? options.machineNames(machineIds) : new Map<string, string>(),
    ])
    const names: Names = {
      members: new Map(members.map((m) => [m.id as string, m.displayName])),
      machines,
    }
    const events = rows.map((row) => projectSecurityEvent(row, names))
    return c.json({
      events,
      nextBefore: rows.length === query.limit ? rows[rows.length - 1]!.id : null,
    })
  })

  app.route('/auth/admin', routes)
}
