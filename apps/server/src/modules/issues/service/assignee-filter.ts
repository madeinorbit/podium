/**
 * WHOSE TASKS A LISTING HOLDS (POD-6296, design §2.2 and §2.3).
 *
 * Every member reads every task, so a listing is narrowed by choice, never by
 * right. The narrowing is by assignee, the task's one accountable human
 * (`issues.owner_user_id`, POD-6287). An agent's `me` is the human it acts
 * for, never the agent and never the task's assignee: Bob's agent on Alice's
 * task still means Bob.
 *
 * The default differs by listing. Discovery (`list`, `search`, `tree`, `deck`)
 * shows everyone's tasks, because finding Alice's task is the point of it.
 * Ready work is what an agent picks up next, so on a shared instance it is the
 * caller's own human's. On a one-member instance every task is that member's,
 * and the default reads `all` so nothing about such an instance changes.
 */

import { asUserId, type UserId } from '@podium/model'
import { IssueRefusal } from './refusal'

/** `undefined` = every assignee. */
export type AssigneeScope = UserId | undefined

/** What a listing means when the caller names no assignee. */
export type AssigneeDefault = 'me' | 'all'

export interface AssigneeMember {
  id: string
  displayName: string
  email: string | null
}

/** The member directory the resolution reads; `store.users` satisfies it. */
export interface AssigneeMembers {
  get(id: UserId): Promise<AssigneeMember | undefined>
  byEmail(email: string): Promise<AssigneeMember | undefined>
  list(): Promise<AssigneeMember[]>
  hasSeveralActiveMembers(): Promise<boolean>
}

/**
 * Resolve `--assignee me|all|<member>` to the member a listing is narrowed to.
 * `viewer` is the caller's human (`markerUser`): absent for a system job.
 */
export async function resolveAssigneeScope(
  raw: string | undefined,
  opts: { viewer: UserId | undefined; fallback: AssigneeDefault; members: AssigneeMembers },
): Promise<AssigneeScope> {
  const value = raw?.trim()
  if (!value) {
    if (opts.fallback === 'all' || !opts.viewer) return undefined
    return (await opts.members.hasSeveralActiveMembers()) ? opts.viewer : undefined
  }
  const lower = value.toLowerCase()
  if (lower === 'all') return undefined
  if (lower === 'me') {
    if (!opts.viewer) throw new IssueRefusal('`--assignee me` needs a person behind the caller')
    return opts.viewer
  }
  const byId = await opts.members.get(asUserId(value))
  if (byId) return asUserId(byId.id)
  if (value.includes('@')) {
    const byEmail = await opts.members.byEmail(value)
    if (byEmail) return asUserId(byEmail.id)
  }
  const named = (await opts.members.list()).filter(
    (member) => member.displayName.trim().toLowerCase() === lower,
  )
  if (named.length === 1) return asUserId(named[0]!.id)
  if (named.length > 1) {
    throw new IssueRefusal(
      `--assignee ${value} names ${named.length} members (${named.map((m) => m.id).join(', ')}); pass a member id`,
    )
  }
  throw new IssueRefusal(
    `--assignee ${value}: no such member. Use me, all, or a member's id, email or name`,
  )
}

/**
 * Member names for the assignees in a result, so a reader on a shared
 * instance sees "Alice", not a member id. Empty on a one-member instance:
 * there is nobody else to tell apart, and its output stays as it was.
 */
export async function assigneeNames(
  members: AssigneeMembers,
  ids: Iterable<string | null | undefined>,
): Promise<ReadonlyMap<string, string>> {
  const wanted = new Set([...ids].filter((id): id is string => !!id))
  if (wanted.size === 0 || !(await members.hasSeveralActiveMembers())) return new Map()
  const names = new Map<string, string>()
  for (const member of await members.list()) {
    if (wanted.has(member.id)) names.set(member.id, member.displayName || member.email || member.id)
  }
  return names
}
