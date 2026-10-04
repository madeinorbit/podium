import { asIssueId, type IssueProjection, type IssueUserStateWire } from '@podium/model'
import type { NavigationProvider } from '../src/engine/navigation-provider'
import type { SessionView } from '../src/session-values'
import { missionIssueIds, missionRootFor } from '../src/values'

/** Explicit, stateless navigation port for engine-only fixtures. Production
 * clients install the pool's provider; no record arrays live in engine state. */
export function fixtureNavigation(rows: {
  issues(): readonly IssueProjection[]
  sessions(): readonly SessionView[]
  markers?(): readonly IssueUserStateWire[]
  follow?(changed: () => void): () => void
}): NavigationProvider {
  const session = (id: string) => rows.sessions().find(row => row.sessionId === id)
  return {
    issue: id => rows.issues().find(row => row.id === id),
    missionRoot: id => missionRootFor(rows.issues(), asIssueId(id))?.id,
    missionMembers: id => missionIssueIds(rows.issues(), id, rows.sessions()),
    session,
    sessionMembership: session,
    worktreeSessions: () => rows.sessions(),
    issueSessions: id => rows.sessions().filter(row => row.issueId === id && !row.archived),
    issueReadAt: id => rows.markers?.().find(row => row.entityId === id)?.readAt,
    activityAt(id) {
      const issues = rows.issues(), members = new Set([id])
      let moved = true
      while (moved) {
        moved = false
        for (const issue of issues) if (issue.parentId && members.has(issue.parentId) && !members.has(issue.id)) {
          members.add(issue.id)
          moved = true
        }
      }
      const stamps = [...issues.filter(row => members.has(row.id)).map(row => row.updatedAt),
        ...rows.sessions().filter(row => row.issueId && members.has(row.issueId)).map(row => row.lastActiveAt)]
      return stamps.filter((stamp): stamp is string => !!stamp).sort().at(-1)
    },
    ...(rows.follow ? { watch: (_read, changed) => rows.follow!(changed), onTopology: rows.follow } : {}),
  }
}
