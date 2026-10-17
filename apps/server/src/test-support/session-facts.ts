import {
  asMachineId,
  firstAdminMemberId,
  type IssueId,
  type MachineId,
  type SessionId,
  type SessionMeta,
} from '@podium/model'
import { isMemberCwd, sessionsForIssue } from '../issue-util'
import type { SessionFacts } from '../modules/sessions/facts'

/**
 * A `SessionMeta` read back as {@link SessionFacts}, FOR FIXTURES ONLY.
 *
 * Production has exactly one producer of facts — `sessionFactsOf`, over a live
 * `Session` — and this is deliberately not it. It exists because the server's
 * test fixtures describe their fleet as `SessionMeta` literals (that is what
 * the helpers in the suites build), and every internal dep now asks for facts.
 * Converting at the fixture boundary keeps those suites describing sessions the
 * way they always have.
 *
 * The direction matters: facts are a SUBSET of what a wired session knows, so
 * this only ever drops fields. It never invents one the projection would have
 * computed — a fixture that needs `displayRef` or `machineName` is describing a
 * WIRED read and should keep using one.
 */
export function metaAsFacts(meta: SessionMeta): SessionFacts {
  return {
    sessionId: meta.sessionId,
    // `SessionMeta` carries no owner — ownership is asked for separately
    // (`sessionOwner`) — so a fixture's fleet is the one account a test store
    // has, which is the same default the mint path applies.
    ownerUserId: firstAdminMemberId(),
    agentKind: meta.agentKind,
    cwd: meta.cwd,
    ...(meta.issueId ? { issueId: meta.issueId } : {}),
    // A live session always has one; a fixture literal often omits it, and
    // 'local' is the sentinel those fixtures already mean by leaving it out.
    machineId: meta.machineId ?? asMachineId('local'),
    status: meta.status,
    archived: meta.archived === true,
    headless: meta.headless === true,
    title: meta.title,
    name: meta.name ?? '',
    ...(meta.spawnedBy ? { spawnedBy: meta.spawnedBy } : {}),
    createdAt: meta.createdAt,
    lastActiveAt: meta.lastActiveAt,
    ...(meta.stoppedAt ? { stoppedAt: meta.stoppedAt } : {}),
    ...(meta.exitCode !== undefined ? { exitCode: meta.exitCode } : {}),
    ...(meta.agentState ? { agentState: meta.agentState } : {}),
    busy: meta.busy === true,
    ...(meta.resume ? { resume: meta.resume } : {}),
    ...(meta.workState ? { workState: meta.workState } : {}),
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.effort ? { effort: meta.effort } : {}),
    ...(meta.accountId ? { accountId: meta.accountId } : {}),
    ...(meta.observedModel ? { observedModel: meta.observedModel } : {}),
    ...(meta.observedEffort ? { observedEffort: meta.observedEffort } : {}),
    ...(meta.requestedModel ? { requestedModel: meta.requestedModel } : {}),
    ...(meta.requestedEffort ? { requestedEffort: meta.requestedEffort } : {}),
    ...(meta.contextUsagePercent !== undefined
      ? { contextUsagePercent: meta.contextUsagePercent }
      : {}),
    ...(meta.draftUpdatedAt !== undefined ? { draftUpdatedAt: meta.draftUpdatedAt } : {}),
    refIssueId: meta.refIssueId ?? null,
    refLetter: meta.refLetter ?? null,
    refDraft: meta.refDraft ?? null,
  }
}

export const metasAsFacts = (metas: readonly SessionMeta[]): SessionFacts[] =>
  metas.map(metaAsFacts)

/**
 * THE SESSION READS a fixture used to satisfy with `listSessions` alone.
 *
 * Spread into a deps literal — `...sessionReadPorts(() => sessions)` — it wires
 * the facts reads plus the three narrow projections over one fixture array.
 * Every one is derived from the SAME source, which is what the single
 * `listSessions` port gave a fixture for free and what a hand-written stub of
 * many ports can silently lose.
 *
 * `sessionFacts` and `runningSessionFacts` are synchronous because the
 * production reads are: they touch the resident map and return. The `read*`
 * facts reads are asynchronous because production answers them from the
 * database (POD-6160). A fixture that wants to observe reads can still wrap the
 * supplier.
 */
export function sessionReadPorts(source: () => readonly SessionMeta[]): {
  runningSessionFacts(): SessionFacts[]
  readSessionFacts(): Promise<SessionFacts[]>
  readSessionFactsByIds(sessionIds: Iterable<SessionId>): Promise<SessionFacts[]>
  readSessionFactsById(sessionId: SessionId): Promise<SessionFacts | undefined>
  readSessionFactsByIssue(worktreePath: string | null, issueId: IssueId | undefined): Promise<SessionFacts[]>
  readSessionFactsByWorktree(worktreePath: string | null): Promise<SessionFacts[]>
  readSessionFactsByMachine(machineId: MachineId): Promise<SessionFacts[]>
  readSessionFactsWithStatuses(statuses: readonly SessionFacts['status'][]): Promise<SessionFacts[]>
  readSessionFactsByIdPrefix(prefix: string): Promise<SessionFacts[]>
  readSessionFactsByBirthRef(ref: { seq: number; letter: string } | { draft: number }): Promise<SessionFacts[]>
  readSessionFactsSpawnedBy(parentIds: readonly SessionId[]): Promise<SessionFacts[]>
  sessionById(sessionId: SessionId): Promise<SessionMeta | undefined>
  listSessionsForIssue(worktreePath: string | null, issueId: IssueId): Promise<SessionMeta[]>
  sessionsById(sessionIds: Iterable<SessionId>): Promise<SessionMeta[]>
} {
  const facts = () => metasAsFacts(source())
  const running = (s: SessionFacts) => s.status === 'live' || s.status === 'starting' || s.status === 'reconnecting'
  return {
    runningSessionFacts: () => facts().filter(running),
    readSessionFacts: async () => facts(),
    readSessionFactsByIds: async (sessionIds) => {
      const byId = new Map(facts().map((s) => [s.sessionId, s]))
      return [...new Set(sessionIds)].flatMap((id) => {
        const found = byId.get(id)
        return found ? [found] : []
      })
    },
    readSessionFactsById: async (sessionId) => facts().find((s) => s.sessionId === sessionId),
    readSessionFactsByIssue: async (worktreePath, issueId) => sessionsForIssue(worktreePath, facts(), issueId),
    readSessionFactsByWorktree: async (worktreePath) =>
      worktreePath ? facts().filter((s) => isMemberCwd(worktreePath, s.cwd)) : [],
    readSessionFactsByMachine: async (machineId) => facts().filter((s) => s.machineId === machineId),
    readSessionFactsWithStatuses: async (statuses) => facts().filter((s) => statuses.includes(s.status)),
    readSessionFactsByIdPrefix: async (prefix) => (prefix ? facts().filter((s) => s.sessionId.startsWith(prefix)) : []),
    readSessionFactsByBirthRef: async (ref) =>
      facts().filter((s) => ('draft' in ref ? s.refDraft === ref.draft : s.refLetter === ref.letter)),
    readSessionFactsSpawnedBy: async (parentIds) => {
      const values = new Set(parentIds.map((id) => `session:${id}`))
      return facts().filter((s) => s.spawnedBy !== undefined && values.has(s.spawnedBy))
    },
    sessionById: async (sessionId) => source().find((s) => s.sessionId === sessionId),
    listSessionsForIssue: async (worktreePath, issueId) =>
      sessionsForIssue(worktreePath, [...source()], issueId),
    sessionsById: async (sessionIds) => {
      const wanted = new Set(sessionIds)
      return source().filter((s) => wanted.has(s.sessionId))
    },
  }
}
