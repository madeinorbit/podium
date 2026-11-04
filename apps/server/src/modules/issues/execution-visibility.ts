/**
 * EXECUTION-PRIVATE TASK FIELDS, APPLIED (design §4.2, POD-6288).
 *
 * `@podium/model`'s `issue-execution.ts` is the rule: which of a task's fields
 * point into someone's private work, and who receives them. This module reads
 * the facts that rule needs (machine custodians, session owners) in one grouped
 * read per table, and applies it to an issue command's result before it leaves
 * the server. The feed applies the same rule through `feed-visibility.ts`.
 */

import {
  FULL_EXECUTION_ACCESS,
  type IssueExecutionAccess,
  type IssueExecutionFacts,
  type IssueExecutionPointers,
  issueExecutionAccess,
  issueExecutionSessionIds,
  type UserId,
  withoutHiddenExecutionFields,
} from '@podium/model'
import type { GrantRow } from '../../store/grants'
import type { IssueRow, SessionRow } from '../../store/types'

/** The store reads the facts come from. */
export interface ExecutionFactsStore {
  readonly grants: {
    loadForResources(kind: string, ids: readonly string[]): Promise<Map<string, GrantRow[]>>
  }
  readonly sessions: {
    getSessions(ids: readonly string[]): Promise<Map<string, SessionRow>>
  }
}

/** A task row's private pointers, in the rule's vocabulary. */
export function executionPointersOf(
  row: Pick<
    IssueRow,
    | 'ownerUserId'
    | 'machineId'
    | 'coordinatorSessionId'
    | 'startedBySession'
    | 'humanQuestionAskedBy'
  >,
): IssueExecutionPointers {
  return {
    owner: row.ownerUserId ?? null,
    machineId: row.machineId ?? null,
    coordinatorSessionId: row.coordinatorSessionId ?? null,
    startedBySession: row.startedBySession ?? null,
    askedBy: row.humanQuestionAskedBy ?? null,
  }
}

/** The custodian of a machine, from its grant edges: the custody `manage` edge. */
export function custodianFromEdges(edges: readonly GrantRow[] | undefined): UserId | null {
  const edge = edges?.find((grant) => grant.verb === 'manage' && grant.custody === true)
  return edge ? (edge.grantee as UserId) : null
}

/**
 * The facts for these tasks: one grouped read of machine grants and one of
 * sessions, whatever the number of tasks.
 */
export async function readExecutionFacts(
  store: ExecutionFactsStore,
  tasks: readonly IssueExecutionPointers[],
): Promise<IssueExecutionFacts> {
  const machineIds = [...new Set(tasks.flatMap((task) => (task.machineId ? [task.machineId] : [])))]
  const sessionIds = [...new Set(tasks.flatMap((task) => issueExecutionSessionIds(task)))]
  const [machineGrants, sessions] = await Promise.all([
    machineIds.length === 0
      ? new Map<string, GrantRow[]>()
      : store.grants.loadForResources('machine', machineIds),
    sessionIds.length === 0
      ? new Map<string, SessionRow>()
      : store.sessions.getSessions(sessionIds),
  ])
  return {
    custodianOf: (machineId) => custodianFromEdges(machineGrants.get(machineId)),
    sessionOwnerOf: (sessionId) => {
      const row = sessions.get(sessionId)
      return row === undefined ? undefined : (row.ownerUserId ?? null)
    },
  }
}

/** Keys whose presence marks an object as carrying a task's private fields. */
const PRIVATE_KEYS = [
  'worktreePath',
  'machineId',
  'coordinatorSessionId',
  'startedBySession',
  'humanQuestionAskedBy',
  'asked',
] as const

const carriesPrivateField = (row: Record<string, unknown>): boolean =>
  PRIVATE_KEYS.some((key) => key in row)

/**
 * AN ISSUE COMMAND'S RESULT, AS `viewer` MAY RECEIVE IT.
 *
 * Walks the result once and finds every object that is a task (its `id` is a
 * task id) carrying one of the private keys, whatever shape holds it: a report,
 * a list of them, a projection inside a mutation result, a search hit. Each is
 * reduced by the rule; nothing else in the result is touched. `viewer === null`
 * is the server reading for itself and returns the result unchanged.
 *
 * A walk rather than a per-command step because the private fields leave by
 * some sixty commands' results, and a step remembered per command is the step
 * the sixty-first forgets.
 */
export async function withoutHiddenTaskFields<T>(
  value: T,
  viewer: UserId | null,
  read: {
    readonly rows: (ids: readonly string[]) => Promise<ReadonlyMap<string, IssueRow>>
    readonly store: ExecutionFactsStore
  },
): Promise<T> {
  if (viewer === null) return value
  const candidates = new Set<string>()
  const collect = (item: unknown, depth: number): void => {
    if (!item || typeof item !== 'object' || depth > 32) return
    if (Array.isArray(item)) {
      for (const child of item) collect(child, depth + 1)
      return
    }
    const row = item as Record<string, unknown>
    if (typeof row.id === 'string' && carriesPrivateField(row)) candidates.add(row.id)
    for (const child of Object.values(row)) collect(child, depth + 1)
  }
  collect(value, 0)
  if (candidates.size === 0) return value
  const rows = await read.rows([...candidates])
  if (rows.size === 0) return value
  const pointers = new Map([...rows].map(([id, row]) => [id, executionPointersOf(row)] as const))
  const facts = await readExecutionFacts(read.store, [...pointers.values()])
  const access = new Map<string, IssueExecutionAccess>()
  const accessOf = (id: string): IssueExecutionAccess => {
    const known = access.get(id)
    if (known) return known
    const task = pointers.get(id)
    const decided = task ? issueExecutionAccess(viewer, task, facts) : FULL_EXECUTION_ACCESS
    access.set(id, decided)
    return decided
  }
  const replace = (item: unknown, depth: number): unknown => {
    if (!item || typeof item !== 'object' || depth > 32) return item
    if (Array.isArray(item)) return item.map((child) => replace(child, depth + 1))
    // Only plain records are rebuilt; a Date or a Map leaves as it came.
    if (Object.getPrototypeOf(item) !== Object.prototype) return item
    const row = item as Record<string, unknown>
    const own =
      typeof row.id === 'string' && pointers.has(row.id) && carriesPrivateField(row)
        ? withoutHiddenExecutionFields(row, accessOf(row.id), {
            unset: row.worktreePath === null || 'origin' in row ? 'null' : 'absent',
          })
        : row
    return Object.fromEntries(
      Object.entries(own).map(([key, child]) => [key, replace(child, depth + 1)]),
    )
  }
  return replace(value, 0) as T
}
