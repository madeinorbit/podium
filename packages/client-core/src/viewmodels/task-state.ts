import { isAgentConfirmedComputing, type SessionMeta } from '@podium/model'
import { withoutShells } from '../focus'

export interface RankedTaskIssue {
  deletedAt?: string
  needsHuman: boolean
  blocked: boolean
  dependents: readonly { type: string }[]
  gitState?: { shared?: boolean; ahead?: number }
  childCount: number
  childDoneCount: number
}

export interface TaskProgress {
  total: number
  done: number
  liveAgents: number
}

export type TaskStateSlot =
  | { kind: 'deleted' }
  | { kind: 'needs-human' }
  | { kind: 'blocked' }
  | { kind: 'blocking' }
  | { kind: 'live'; count: number }
  | { kind: 'merge'; ahead: number }
  | { kind: 'subtree'; done: number; total: number }

export type TaskStateWord = {
  text: string
  tone: 'attention' | 'alert' | 'live' | 'quiet'
}

/** Commits waiting to land. Shared checkouts have no meaningful merge axis. */
export function taskAheadCount(issue: RankedTaskIssue): number {
  return issue.gitState?.shared ? 0 : (issue.gitState?.ahead ?? 0)
}

/** The canonical state rank used by desktop cards and iPhone rows. */
export function rankedTaskStateSlots(
  issue: RankedTaskIssue,
  options: { workingAgents: number; progress?: TaskProgress | null },
): TaskStateSlot[] {
  const slots: TaskStateSlot[] = []
  if (issue.deletedAt) slots.push({ kind: 'deleted' })
  if (issue.needsHuman) slots.push({ kind: 'needs-human' })
  if (issue.blocked) slots.push({ kind: 'blocked' })
  if (issue.dependents.some((dependency) => dependency.type === 'blocks')) {
    slots.push({ kind: 'blocking' })
  }
  const live = options.workingAgents + (options.progress?.liveAgents ?? 0)
  if (live > 0) slots.push({ kind: 'live', count: live })
  const ahead = taskAheadCount(issue)
  if (ahead > 0) slots.push({ kind: 'merge', ahead })
  const subtree =
    options.progress ??
    (issue.childCount > 0
      ? { total: issue.childCount, done: issue.childDoneCount, liveAgents: 0 }
      : null)
  if (subtree && subtree.total > 0) {
    slots.push({ kind: 'subtree', done: subtree.done, total: subtree.total })
  }
  return slots
}

/** The single highest-ranked phrase a phone row has room to show. */
export function taskStateWord(
  issue: RankedTaskIssue,
  workingAgents: number,
  progress?: TaskProgress | null,
): TaskStateWord | null {
  const [top] = rankedTaskStateSlots(issue, { workingAgents, progress })
  if (!top) return null
  switch (top.kind) {
    case 'deleted':
      return { text: 'deleted', tone: 'alert' }
    case 'needs-human':
      return { text: 'needs you', tone: 'attention' }
    case 'blocked':
      return { text: 'blocked', tone: 'alert' }
    case 'blocking':
      return { text: 'blocking', tone: 'alert' }
    case 'live':
      return { text: `${top.count} working`, tone: 'live' }
    case 'merge':
      return { text: `↑${top.ahead} to land`, tone: 'attention' }
    case 'subtree':
      return { text: `${top.done}/${top.total}`, tone: 'quiet' }
  }
}

/** The desktop and iPhone spelling of a confirmed computing-agent count. */
export function confirmedWorkingAgentCount(sessions: readonly SessionMeta[], now: number): number {
  return withoutShells([...sessions]).reduce(
    (count, session) => count + (isAgentConfirmedComputing(session, now) ? 1 : 0),
    0,
  )
}

/** Confirmed workers keyed through canonical issue membership. */
export function confirmedWorkingAgentCountsByIssue<
  T extends { id: string; memberSessionIds?: readonly string[] },
>(issues: readonly T[], sessions: readonly SessionMeta[], now: number): Map<string, number> {
  const sessionById = new Map(sessions.map((session) => [session.sessionId as string, session]))
  const counts = new Map<string, number>()
  for (const issue of issues) {
    const members = (issue.memberSessionIds ?? [])
      .map((id) => sessionById.get(id))
      .filter((session): session is SessionMeta => session !== undefined)
    counts.set(issue.id, confirmedWorkingAgentCount(members, now))
  }
  return counts
}
