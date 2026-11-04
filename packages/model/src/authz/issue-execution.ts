/**
 * SHARED AND EXECUTION-PRIVATE TASK DATA (design §4.2, POD-6288).
 *
 * Every active member reads every task (§2.2), but a task row also carries
 * pointers into one person's private work: the worktree on their machine and
 * the sessions that coordinate or started it. Those pointers go only to the
 * person they point at. Everything else on the task is shared.
 *
 * | Field                                   | Class              | Who receives it                      |
 * |-----------------------------------------|--------------------|--------------------------------------|
 * | `worktreePath`, `machineId`             | execution-private  | the custodian of the task's machine  |
 * | `coordinatorSessionId`                  | execution-private  | the owner of that session            |
 * | `startedBySession`                      | execution-private  | the owner of that session            |
 * | `asked.by` (report: `humanQuestionAskedBy`) | execution-private | the owner of that session         |
 * | every other field                       | shared             | every reader of the task             |
 *
 * Where the thing pointed at has no person (a machine nobody holds custody of,
 * no machine recorded, or a session row that no longer exists) the pointer goes
 * to the task's assignee (`owner`): it can reach nobody else's private work,
 * and a one-member instance keeps seeing exactly what it saw before.
 *
 * What a reader of somebody else's sessions gets instead is the D13 summary
 * ({@link IssueSessionSummaryEntry}): owner, title, live or idle.
 *
 * This module is the RULE. The server reads the facts (custodians, session
 * owners) and applies it to every path a task leaves by: command results, the
 * feed's bootstrap and deltas.
 */

import type { UserId } from '../ids/brands'

/** The projection keys that point into someone's private work. */
export const ISSUE_EXECUTION_PRIVATE_FIELDS = [
  'worktreePath',
  'machineId',
  'coordinatorSessionId',
  'startedBySession',
] as const

/** The private fields of a task, as a task row names them. */
export interface IssueExecutionPointers {
  /** The task's assignee: who receives a pointer that points at no person. */
  readonly owner: string | null | undefined
  readonly machineId?: string | null
  readonly coordinatorSessionId?: string | null
  readonly startedBySession?: string | null
  /** The session that asked the open question, if any. */
  readonly askedBy?: string | null
}

/** The people behind the pointers, read by the caller from the store. */
export interface IssueExecutionFacts {
  /** The custodian of a machine; `null` when nobody holds custody. */
  custodianOf(machineId: string): UserId | string | null | undefined
  /** The owner of a session; `undefined` when there is no such session. */
  sessionOwnerOf(sessionId: string): UserId | string | null | undefined
}

/** What one reader may see of one task's private fields. */
export interface IssueExecutionAccess {
  /** `worktreePath` and `machineId`. */
  readonly workspace: boolean
  /** A session pointer (coordinator, started-by, asker). */
  session(sessionId: string): boolean
}

/** Everything visible: the server's own reads. */
export const FULL_EXECUTION_ACCESS: IssueExecutionAccess = {
  workspace: true,
  session: () => true,
}

/**
 * THE RULE: which of one task's private fields `viewer` may receive.
 * `viewer === null` is the server reading for itself, which sees everything.
 */
export function issueExecutionAccess(
  viewer: string | null,
  task: IssueExecutionPointers,
  facts: IssueExecutionFacts,
): IssueExecutionAccess {
  if (viewer === null) return FULL_EXECUTION_ACCESS
  const assignee = task.owner ?? null
  const personOr = (person: string | null | undefined): boolean =>
    person ? person === viewer : assignee === viewer
  const workspace = personOr(task.machineId ? facts.custodianOf(task.machineId) : null)
  return {
    workspace,
    session: (sessionId) => personOr(facts.sessionOwnerOf(sessionId)),
  }
}

/** The session ids a task's private fields point at. */
export function issueExecutionSessionIds(task: IssueExecutionPointers): string[] {
  return [task.coordinatorSessionId, task.startedBySession, task.askedBy].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  )
}

/**
 * The task as `access` allows: every private field it may not see is removed,
 * nothing else is touched. Works on the feed's `IssueProjection` (an unset
 * worktree is an absent key) and on the command layer's `IssueReport` (an unset
 * worktree is `null`, which `unset: 'null'` keeps), so both spellings of the
 * asker are covered.
 */
export function withoutHiddenExecutionFields<T extends object>(
  task: T,
  access: IssueExecutionAccess,
  opts: { unset?: 'absent' | 'null' } = {},
): T {
  const out = { ...(task as Record<string, unknown>) }
  if (!access.workspace) {
    if (opts.unset === 'null' && 'worktreePath' in out) out.worktreePath = null
    else delete out.worktreePath
    delete out.machineId
  }
  for (const key of ['coordinatorSessionId', 'startedBySession', 'humanQuestionAskedBy'] as const) {
    const id = out[key]
    if (typeof id === 'string' && !access.session(id)) delete out[key]
  }
  const asked = out.asked as { by?: unknown } | undefined
  if (asked && typeof asked.by === 'string' && !access.session(asked.by)) {
    const { by: _by, ...rest } = asked
    out.asked = rest
  }
  return out as T
}

/**
 * THE D13 SESSION SUMMARY: what a task reader learns about each session on the
 * task, whoever owns it. No content, no controls, no ids into the session.
 */
export interface IssueSessionSummaryEntry {
  /** The member the session belongs to. */
  readonly owner: string | null
  /** Its curated name, else its terminal title. */
  readonly title: string
  /** `live` while the agent is working, `idle` otherwise. */
  readonly state: 'live' | 'idle'
}

/**
 * PER-MEMBER MARKER EVENTS (POD-6291). A read, unread or pin is a transition of
 * ONE member's own marker (design §4.1 "Self"): the event names that member as
 * `payload.userId`, and it reaches nobody else — not the task's shared
 * activity, not the events feed, not a notification.
 */
export const ISSUE_MARKER_EVENT_KINDS: readonly string[] = [
  'issue.read',
  'issue.unread',
  'issue.pinned',
]

/**
 * Is this event `viewer`'s to see as far as markers go? Every other kind is.
 * An event logged before markers named their member (no `userId`) is the
 * task assignee's, the one member a pre-multi-user marker could belong to.
 */
export function markerEventVisibleTo(
  event: { readonly kind: string; readonly payload: unknown },
  viewer: string,
  assignee: string | null | undefined,
): boolean {
  if (!ISSUE_MARKER_EVENT_KINDS.includes(event.kind)) return true
  const payload = event.payload as { userId?: unknown } | null | undefined
  const owner = typeof payload?.userId === 'string' ? payload.userId : (assignee ?? null)
  return owner === viewer
}

/** Payload keys of a task's events that name a place on a machine. */
const EVENT_WORKSPACE_KEYS = ['worktreePath', 'machineId', 'cwd'] as const
/** Payload keys of a task's events that hold a session id. */
const EVENT_SESSION_KEYS = ['sessionId', 'causedBySessionId', 'actorSessionId'] as const
/** Kinds whose `from` is the previous session. */
const EVENT_FROM_IS_SESSION = new Set(['issue.session_attached', 'issue.coordinator_set'])

/**
 * A TASK EVENT'S PAYLOAD AS `access` ALLOWS (design §4.2 applied to the task's
 * activity, POD-6291). The same rule as the task's own fields: a machine path
 * goes to the custodian of the task's machine, a session id to that session's
 * owner. A hidden session id leaves `sessionHidden: true` behind, so "the
 * coordinator changed" never reads as "the coordinator was cleared". An agent
 * actor in the attribution keeps its kind and loses its id. Nothing else in the
 * payload is touched.
 */
export function withoutHiddenEventFields(
  kind: string,
  payload: unknown,
  access: IssueExecutionAccess,
): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const out = { ...(payload as Record<string, unknown>) }
  let changed = false
  if (!access.workspace) {
    for (const key of EVENT_WORKSPACE_KEYS) {
      if (key in out && out[key] != null) {
        delete out[key]
        changed = true
      }
    }
  }
  const sessionKeys: string[] = [
    ...EVENT_SESSION_KEYS,
    ...(EVENT_FROM_IS_SESSION.has(kind) ? ['from'] : []),
  ]
  for (const key of sessionKeys) {
    const id = out[key]
    if (typeof id === 'string' && !access.session(id)) {
      delete out[key]
      if (key === 'sessionId') out.sessionHidden = true
      changed = true
    }
  }
  const attribution = out.attribution as { actor?: unknown } | undefined
  if (
    attribution &&
    typeof attribution.actor === 'string' &&
    attribution.actor.startsWith('session:')
  ) {
    if (!access.session(attribution.actor.slice('session:'.length))) {
      out.attribution = { ...attribution, actor: 'session' }
      changed = true
    }
  }
  return changed ? out : payload
}

/** The session ids a task event's payload names, for the facts read. */
export function eventSessionIds(kind: string, payload: unknown): string[] {
  if (payload === null || typeof payload !== 'object') return []
  const p = payload as Record<string, unknown>
  const ids: string[] = []
  for (const key of [...EVENT_SESSION_KEYS, ...(EVENT_FROM_IS_SESSION.has(kind) ? ['from'] : [])]) {
    const id = p[key]
    if (typeof id === 'string' && id.length > 0) ids.push(id)
  }
  const actor = (p.attribution as { actor?: unknown } | undefined)?.actor
  if (typeof actor === 'string' && actor.startsWith('session:'))
    ids.push(actor.slice('session:'.length))
  return ids
}
