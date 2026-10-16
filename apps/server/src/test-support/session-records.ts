import type { SessionId } from '@podium/model'
import { isIssueMember, isMemberCwd } from '../issue-util'
import type { SessionRecordReads, SessionSubject } from '../modules/sessions/records'
import type { Session } from '../modules/sessions/session'

/**
 * SessionRecords over a map of resident sessions only, for unit tests whose
 * sessions were never written to a store (POD-6160). Selection rules are the
 * real ones (`isIssueMember`, `isMemberCwd`, …); there are no records and
 * nothing to compare. A test of the database path uses a real store and
 * registry.
 */
export function residentRecords(sessions: ReadonlyMap<SessionId, Session>): SessionRecordReads {
  const where = (match: (s: Session) => boolean): SessionSubject[] => [...sessions.values()].filter(match)
  return {
    all: async () => where(() => true),
    issueMembers: async (worktreePath, issueId) => where((s) => isIssueMember(worktreePath, issueId, s)),
    underPath: async (worktreePath) => (worktreePath ? where((s) => isMemberCwd(worktreePath, s.cwd)) : []),
    onMachine: async (machineId) => where((s) => s.machineId === machineId),
    withStatuses: async (statuses) => where((s) => statuses.includes(s.status)),
    withIdPrefix: async (prefix) => (prefix ? where((s) => s.sessionId.startsWith(prefix)) : []),
    // Without an issue table there is no seq to check: every letter match is a
    // candidate, which the caller's formatted-ref comparison then narrows.
    birthRefCandidates: async (ref) =>
      where((s) => ('draft' in ref ? s.refDraft === ref.draft : s.refLetter === ref.letter)),
    childrenOf: async (parentIds) => {
      const values = new Set(parentIds.map((id) => `session:${id}`))
      return where((s) => s.spawnedBy !== undefined && values.has(s.spawnedBy))
    },
    // The map's order, as the full list has it.
    resolve: async (ids) => {
      const wanted = new Set(ids)
      return new Map(where((s) => wanted.has(s.sessionId)).map((s) => [s.sessionId, s]))
    },
  }
}
