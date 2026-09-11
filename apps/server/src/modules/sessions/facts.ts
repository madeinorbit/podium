import type {
  AccountId,
  AgentKind,
  AgentRuntimeState,
  IssueId,
  MachineId,
  ResumeRef,
  SessionId,
  SessionMeta,
  UserId,
  WorkState,
} from '@podium/model'
import { isIssueMember, isMemberCwd } from '../../issue-util'
import type { Session } from './session'

/**
 * THE CHEAP SESSION READ — WHAT THE SERVER KNOWS ABOUT ITSELF [POD-3857].
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS BESIDE `SessionView`
 * ---------------------------------------------------------------------------
 *
 * `SessionView.list()` is a READER-SCOPED WIRE PROJECTION: per session it runs
 * an authorization check (an issue row plus that resource's grant edges), a
 * per-user overlay read, a machine-name resolution and a display-ref
 * resolution, and over the whole pass a queued-message count. On the live
 * corpus that is ~733 ms for 1119 sessions, and it was running 6.2 times a
 * minute under the caller label `unlabeled` — because roughly forty internal
 * call sites asked for it when what they wanted was `issueId`, `cwd` and
 * `status`.
 *
 * None of those internal callers is a reader. The steward deciding which
 * session to nudge, the worktree GC asking whether a path is occupied, the
 * delivery service resolving session→issue membership — every one of them is
 * the server reasoning about its own fleet, with no principal to scope to and
 * no wire to cross. They pay for a projection and then read three fields off
 * it.
 *
 * So this is the read they actually wanted: a plain snapshot of the live
 * registry, taken with NO I/O AT ALL. It touches the `Map<SessionId, Session>`
 * and nothing else — not the store, not the machines service, not the session
 * state service. That is the whole invariant, and it is what makes a facts read
 * O(n) pointer copies instead of O(n) round trips.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY ABSENT, AND WHAT TO DO INSTEAD
 * ---------------------------------------------------------------------------
 *
 * Five `SessionMeta` fields cannot be answered from memory, and their absence
 * here is the point rather than an omission to be fixed later:
 *
 *  - `displayRef` needs the ref issue's row and its repo's prefix (two store
 *    reads),
 *  - `machineName` needs the machines service,
 *  - `condition` needs the harness login probe,
 *  - `readAt` / `unread` / `snoozedUntil` need the reader's own overlay,
 *  - `queuedMessageCount` on the wire is a fresh count from the durable queue.
 *    (`Session.queuedMessageCount` — carried here — is the registry's transient
 *    mirror of it, which is what the inbox reasons about.)
 *
 * A caller that genuinely needs one of those wants a WIRED session, and the
 * narrow projections already exist for exactly that: `sessionById` (POD-1646),
 * `sessionsById` (POD-2322) and `listSessionsForIssue` (POD-1639). The pattern
 * every migrated caller follows is SELECT WITH FACTS, WIRE THE FEW: decide over
 * the cheap snapshot, then project only the handful of sessions that survive.
 *
 * ---------------------------------------------------------------------------
 * NOT A WIRE TYPE
 * ---------------------------------------------------------------------------
 *
 * `SessionFacts` is trusted server-internal data and has had no visibility check
 * applied. It must never be returned from an RPC, published to the ledger, or
 * embedded in anything a client reads. The compiler helps: it is structurally
 * assignable FROM a `Session` and shares field names with `SessionMeta`, but it
 * is not a `SessionMeta` and cannot be passed where one is required.
 */
export interface SessionFacts {
  sessionId: SessionId
  /** Accountable human owner — the input to every ownership decision. */
  ownerUserId: UserId
  agentKind: AgentKind
  /** Working directory. The cwd-containment half of issue membership. */
  cwd: string
  /** EXPLICIT issue attachment only. The other half of issue membership; see
   *  {@link isIssueMember} for the precedence rule the two obey together. */
  issueId?: IssueId
  machineId: MachineId
  status: SessionMeta['status']
  archived: boolean
  headless: boolean
  title: string
  /** Curated name; empty string = nobody named it (NOT absent — the empty
   *  string is what `name ?? title` has to fall through on, and `??` does not,
   *  which is why this stays a required string exactly as `Session` holds it). */
  name: string
  spawnedBy?: string
  createdAt: string
  lastActiveAt: string
  stoppedAt?: string
  exitCode?: number
  agentState?: AgentRuntimeState
  /** Terminal busy flag — "a turn is in flight" for a session whose harness
   *  reports no phase at all. */
  busy: boolean
  resume?: ResumeRef
  workState?: WorkState
  model?: string
  effort?: string
  accountId?: AccountId
  observedModel?: string
  observedEffort?: string
  requestedModel?: string
  requestedEffort?: string
  contextUsagePercent?: number
  draftUpdatedAt?: string
  /** The registry's transient mirror of the durable queue depth. */
  queuedMessageCount: number
  refIssueId: IssueId | null
  refLetter: string | null
  refDraft: number | null
}

/** One live session's facts. Pure field copies — see the class doc on why this
 *  may never grow a call into the store or another service. */
export function sessionFactsOf(session: Session): SessionFacts {
  return {
    sessionId: session.sessionId,
    ownerUserId: session.ownerUserId,
    agentKind: session.agentKind,
    cwd: session.cwd,
    ...(session.issueId ? { issueId: session.issueId } : {}),
    machineId: session.machineId,
    status: session.status,
    archived: session.archived === true,
    headless: session.headless === true,
    title: session.title,
    name: session.name,
    ...(session.spawnedBy ? { spawnedBy: session.spawnedBy } : {}),
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    ...(session.stoppedAt ? { stoppedAt: session.stoppedAt } : {}),
    ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
    ...(session.agentState ? { agentState: session.agentState } : {}),
    busy: session.terminal.busy === true,
    ...(session.resume ? { resume: session.resume } : {}),
    ...(session.workState ? { workState: session.workState } : {}),
    ...(session.model ? { model: session.model } : {}),
    ...(session.effort ? { effort: session.effort } : {}),
    ...(session.accountId ? { accountId: session.accountId } : {}),
    ...(session.observedModel ? { observedModel: session.observedModel } : {}),
    ...(session.observedEffort ? { observedEffort: session.observedEffort } : {}),
    ...(session.requestedModel ? { requestedModel: session.requestedModel } : {}),
    ...(session.requestedEffort ? { requestedEffort: session.requestedEffort } : {}),
    ...(session.contextUsagePercent !== undefined
      ? { contextUsagePercent: session.contextUsagePercent }
      : {}),
    ...(session.draftUpdatedAt !== undefined ? { draftUpdatedAt: session.draftUpdatedAt } : {}),
    queuedMessageCount: session.queuedMessageCount,
    refIssueId: session.refIssueId,
    refLetter: session.refLetter,
    refDraft: session.refDraft,
  }
}

/**
 * The facts reads, over the live registry map.
 *
 * The narrowed reads are here rather than left to the caller for the same
 * reason `SessionView` owns `listForIssue` and `byId`: the SELECTION RULE has
 * to have one definition. `byIssue` delegates to {@link isIssueMember} and
 * `byWorktree` to {@link isMemberCwd} — the same predicates the projection's
 * narrow reads use — so a facts read and a wired read of the same question can
 * never select different sets.
 */
export class SessionFactsReader {
  constructor(private readonly sessions: Map<SessionId, Session>) {}

  /** Every live session in the registry, in insertion order. */
  all(): SessionFacts[] {
    const out: SessionFacts[] = []
    for (const session of this.sessions.values()) out.push(sessionFactsOf(session))
    return out
  }

  byId(sessionId: SessionId): SessionFacts | undefined {
    const session = this.sessions.get(sessionId)
    return session ? sessionFactsOf(session) : undefined
  }

  /** The member sessions of ONE issue — explicit `issueId` wins, else cwd
   *  containment in the issue's worktree. */
  byIssue(worktreePath: string | null, issueId: IssueId | undefined): SessionFacts[] {
    const out: SessionFacts[] = []
    for (const session of this.sessions.values()) {
      if (isIssueMember(worktreePath, issueId, session)) out.push(sessionFactsOf(session))
    }
    return out
  }

  /** Every session whose cwd sits inside `worktreePath`, WHATEVER issue it is
   *  attached to. That difference from {@link byIssue} is load-bearing: the free
   *  and GC guards must see a session that shares the path under another issue,
   *  or they delete a worktree out from under it. */
  byWorktree(worktreePath: string | null): SessionFacts[] {
    if (!worktreePath) return []
    const out: SessionFacts[] = []
    for (const session of this.sessions.values()) {
      if (isMemberCwd(worktreePath, session.cwd)) out.push(sessionFactsOf(session))
    }
    return out
  }

  byMachine(machineId: MachineId): SessionFacts[] {
    const out: SessionFacts[] = []
    for (const session of this.sessions.values()) {
      if (session.machineId === machineId) out.push(sessionFactsOf(session))
    }
    return out
  }
}
