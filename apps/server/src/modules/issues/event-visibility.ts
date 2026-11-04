/**
 * THE EVENT LOG AS ONE MEMBER MAY READ IT (POD-6291, design §4.2 and §4.5).
 *
 * `issues.events` reads the durable log, which holds every member's history:
 * their sessions' phases with working directories, the paths of their
 * worktrees, their own read and pin markers. A person, or an agent acting for
 * one, receives:
 *
 * - an event about a SESSION only when that session is theirs (design §2.3),
 *   and none about a session that no longer exists;
 * - an event about a MESSAGE only when the mail read rule gives them that
 *   message (its sender's or recipient session's owner, POD-6284);
 * - a LOCK event by the class of what it names: one naming sessions (its
 *   holders) only for the owners of those sessions, each seeing only their
 *   own session ids; one naming tasks or nobody for all;
 * - an event about a TASK always, since tasks are shared, but
 *   - a read, unread or pin only when it is their own marker, and
 *   - its payload by the task's execution-private rule: a machine path for the
 *     custodian of the task's machine, a session id for that session's owner;
 * - anything else (instance-wide notes like `upstream`) as before. Workflow
 *   events live in their own table and never reach this read.
 *
 * The server reading for itself (no member) receives the log as it is.
 */

import {
  eventSessionIds,
  type IssueExecutionFacts,
  issueExecutionAccess,
  markerEventVisibleTo,
  type UserId,
  withoutHiddenEventFields,
} from '@podium/model'
import type { PodiumEventRecord } from '../../store/events'
import type { IssueRow } from '../../store/types'
import {
  custodianFromEdges,
  type ExecutionFactsStore,
  executionPointersOf,
} from './execution-visibility'

export async function eventsForMember(
  events: readonly PodiumEventRecord[],
  member: UserId,
  read: {
    readonly rows: (ids: readonly string[]) => Promise<ReadonlyMap<string, IssueRow>>
    readonly store: ExecutionFactsStore
    /** Which of these message ids the member may read (the mail read rule).
     *  Absent: a single-member harness, where every message is the member's. */
    readonly visibleMessageIds?: (ids: readonly string[]) => Promise<ReadonlySet<string>>
  },
): Promise<PodiumEventRecord[]> {
  if (events.length === 0) return []
  const subjects = [
    ...new Set(events.map((event) => event.subject).filter((subject) => subject !== '')),
  ]
  const issues = await read.rows(subjects)
  // One read for the sessions the events are about and the ones their
  // payloads and their tasks' private fields name.
  const sessionIds = new Set<string>(subjects.filter((subject) => !issues.has(subject)))
  for (const event of events) {
    if (issues.has(event.subject))
      for (const id of eventSessionIds(event.kind, event.payload)) sessionIds.add(id)
    if (event.kind.startsWith('lock.'))
      for (const id of lockSessionIds(event.payload)) sessionIds.add(id)
  }
  const messageIds = [
    ...new Set(
      events.filter((event) => event.kind.startsWith('message.')).map((event) => event.subject),
    ),
  ]
  for (const row of issues.values()) {
    const pointers = executionPointersOf(row)
    for (const id of [pointers.coordinatorSessionId, pointers.startedBySession, pointers.askedBy]) {
      if (id) sessionIds.add(id)
    }
  }
  const machineIds = [
    ...new Set([...issues.values()].flatMap((row) => (row.machineId ? [row.machineId] : []))),
  ]
  const [sessions, machineGrants, messages] = await Promise.all([
    sessionIds.size === 0 ? new Map() : read.store.sessions.getSessions([...sessionIds]),
    machineIds.length === 0 ? new Map() : read.store.grants.loadForResources('machine', machineIds),
    messageIds.length === 0 || !read.visibleMessageIds
      ? undefined
      : read.visibleMessageIds(messageIds),
  ])
  const facts: IssueExecutionFacts = {
    custodianOf: (machineId) => custodianFromEdges(machineGrants.get(machineId)),
    sessionOwnerOf: (sessionId) => {
      const row = sessions.get(sessionId)
      return row === undefined ? undefined : (row.ownerUserId ?? null)
    },
  }
  const out: PodiumEventRecord[] = []
  for (const event of events) {
    const task = issues.get(event.subject)
    if (task === undefined) {
      const session = sessions.get(event.subject)
      // About a session: its owner only.
      if (session !== undefined) {
        if (session.ownerUserId === member) out.push(event)
        continue
      }
      // About a session that no longer exists: nobody can read it.
      if (event.kind.startsWith('session.') || event.kind.startsWith('agent.')) continue
      // About a message: the mail read rule.
      if (event.kind.startsWith('message.')) {
        if (messages === undefined || messages.has(event.subject)) out.push(event)
        continue
      }
      // A lock event: for the owners of the sessions it names, each seeing
      // only their own; with no session named, for everyone.
      if (event.kind.startsWith('lock.')) {
        const named = lockSessionIds(event.payload)
        if (named.length === 0) {
          out.push(event)
          continue
        }
        const mine = (id: string) => sessions.get(id)?.ownerUserId === member
        if (!named.some(mine)) continue
        out.push(
          named.every(mine)
            ? event
            : { ...event, payload: withoutForeignSessions(event.payload, mine) },
        )
        continue
      }
      out.push(event)
      continue
    }
    if (!markerEventVisibleTo(event, member, task.ownerUserId)) continue
    const payload = withoutHiddenEventFields(
      event.kind,
      event.payload,
      issueExecutionAccess(member, executionPointersOf(task), facts),
    )
    out.push(payload === event.payload ? event : { ...event, payload })
  }
  return out
}

/** The sessions a lock event names: its holders' `sessionId`s and any
 *  `session:<id>` label (the lock service's spelling of an agent holder). */
function lockSessionIds(payload: unknown): string[] {
  const ids = new Set<string>()
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.startsWith('session:')) ids.add(value.slice('session:'.length))
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'sessionId' && typeof inner === 'string' && inner !== '') ids.add(inner)
      else visit(inner)
    }
  }
  visit(payload)
  return [...ids]
}

/** A lock payload with every session that is not the member's taken out: a
 *  `sessionId` key dropped, a `session:<id>` label reduced to `session`. */
function withoutForeignSessions(payload: unknown, mine: (id: string) => boolean): unknown {
  if (typeof payload === 'string') {
    return payload.startsWith('session:') && !mine(payload.slice('session:'.length))
      ? 'session'
      : payload
  }
  if (payload === null || typeof payload !== 'object') return payload
  if (Array.isArray(payload)) return payload.map((item) => withoutForeignSessions(item, mine))
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(payload as Record<string, unknown>)) {
    if (key === 'sessionId' && typeof inner === 'string' && !mine(inner)) continue
    out[key] = withoutForeignSessions(inner, mine)
  }
  return out
}
