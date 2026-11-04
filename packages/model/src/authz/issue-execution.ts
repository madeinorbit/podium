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
