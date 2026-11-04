/**
 * THE EVENT LOG AS ONE MEMBER MAY READ IT (POD-6291, design §4.2 and §4.5).
 *
 * `issues.events` reads the durable log, which holds every member's history:
 * their sessions' phases with working directories, the paths of their
 * worktrees, their own read and pin markers. A person, or an agent acting for
 * one, receives:
 *
 * - an event about a SESSION only when that session is theirs (design §2.3);
 * - an event about a TASK always, since tasks are shared, but
 *   - a read, unread or pin only when it is their own marker, and
 *   - its payload by the task's execution-private rule: a machine path for the
 *     custodian of the task's machine, a session id for that session's owner;
 * - anything else as before.
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
  }
  for (const row of issues.values()) {
    const pointers = executionPointersOf(row)
    for (const id of [pointers.coordinatorSessionId, pointers.startedBySession, pointers.askedBy]) {
      if (id) sessionIds.add(id)
    }
  }
  const machineIds = [
    ...new Set([...issues.values()].flatMap((row) => (row.machineId ? [row.machineId] : []))),
  ]
  const [sessions, machineGrants] = await Promise.all([
    sessionIds.size === 0 ? new Map() : read.store.sessions.getSessions([...sessionIds]),
    machineIds.length === 0 ? new Map() : read.store.grants.loadForResources('machine', machineIds),
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
      if (session !== undefined && session.ownerUserId !== member) continue
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
