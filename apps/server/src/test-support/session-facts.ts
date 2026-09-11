import {
  asMachineId,
  firstAdminMemberId,
  type IssueId,
  type SessionId,
  type SessionMeta,
} from '@podium/model'
import { sessionsForIssue } from '../issue-util'
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
    queuedMessageCount: meta.queuedMessageCount ?? 0,
    refIssueId: meta.refIssueId ?? null,
    refLetter: meta.refLetter ?? null,
    refDraft: meta.refDraft ?? null,
  }
}

export const metasAsFacts = (metas: readonly SessionMeta[]): SessionFacts[] =>
  metas.map(metaAsFacts)

/**
 * THE FOUR SESSION READS a fixture used to satisfy with `listSessions` alone.
 *
 * Spread into a deps literal — `...sessionReadPorts(() => sessions)` — it wires
 * facts plus the three narrow projections over one fixture array. Every one is
 * derived from the SAME source, which is what the single `listSessions` port
 * gave a fixture for free and what a hand-written stub of four ports can
 * silently lose.
 *
 * `sessionFacts` is synchronous because the production read is: it touches a
 * `Map` and returns. A fixture that wants to observe reads can still wrap the
 * supplier.
 */
export function sessionReadPorts(source: () => readonly SessionMeta[]): {
  sessionFacts(): SessionFacts[]
  sessionById(sessionId: SessionId): Promise<SessionMeta | undefined>
  listSessionsForIssue(worktreePath: string | null, issueId: IssueId): Promise<SessionMeta[]>
  sessionsById(sessionIds: Iterable<SessionId>): Promise<SessionMeta[]>
} {
  return {
    sessionFacts: () => metasAsFacts(source()),
    sessionById: async (sessionId) => source().find((s) => s.sessionId === sessionId),
    listSessionsForIssue: async (worktreePath, issueId) =>
      sessionsForIssue(worktreePath, [...source()], issueId),
    sessionsById: async (sessionIds) => {
      const wanted = new Set(sessionIds)
      return source().filter((s) => wanted.has(s.sessionId))
    },
  }
}
