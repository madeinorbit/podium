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
import type { SessionRecordReads } from './records'
import { Session, type SessionDurableFields } from './session'
import { isRunningStatus, type SessionIdentity, type SessionRecord } from './session-record'

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
 *  - `queuedMessageCount` on the wire is a fresh count from the durable queue
 *    (there is no in-memory mirror of it since POD-6155).
 *
 * Internal readers obtain joined values from their sources: `readSessionRefs`
 * for refs, MachinesService for machine labels, and the caller's per-user row
 * for read/snooze state. The narrow projections `sessionById` (POD-1646),
 * `sessionsById` (POD-2322) and `listSessionsForIssue` (POD-1639) still provide
 * visibility checks and the session's own fields for outward-facing reads.
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
  refIssueId: IssueId | null
  refLetter: string | null
  refDraft: number | null
}

/** One live session's facts. Pure field copies — see the class doc on why this
 *  may never grow a call into the store or another service. */
export function sessionFactsOf(session: Session): SessionFacts {
  session.freshenDurable()
  return factsOf(session, session.terminal.busy === true)
}

/** A durable record's facts (POD-6160): nothing runs it, so nothing is busy. */
export function recordFactsOf(record: SessionRecord): SessionFacts {
  return factsOf(record, record.live.busy)
}

/** Either answer's facts: a resident session's or a durable record's. */
export function subjectFacts(subject: Session | SessionRecord): SessionFacts {
  return subject instanceof Session ? sessionFactsOf(subject) : recordFactsOf(subject)
}

/** THE facts projection, over a live session or a durable record. */
function factsOf(session: SessionIdentity & SessionDurableFields, busy: boolean): SessionFacts {
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
    busy,
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
    refIssueId: session.refIssueId,
    refLetter: session.refLetter,
    refDraft: session.refDraft,
  }
}

/**
 * The facts reads.
 *
 * The narrowed reads are here rather than left to the caller for the same
 * reason `SessionView` owns `listForIssue` and `byId`: the SELECTION RULE has
 * to have one definition. The selections live in `SessionRecords`
 * (`isIssueMember`, `isMemberCwd`), shared with the projection's narrow reads,
 * so a facts read and a wired read of the same question can never select
 * different sets.
 *
 * TWO KINDS OF READ (POD-6160). `running()` is the resident running sessions,
 * synchronous and free of I/O. The `read*` methods answer for every live
 * session, resident or not, from the database. The synchronous whole-map reads
 * (`all`, `byId`, `byIssue`, `byWorktree`, `byMachine`) answer only while the
 * map still holds every session, and go when it shrinks (D2g).
 */
export class SessionFactsReader {
  constructor(
    private readonly sessions: ReadonlyMap<SessionId, Session>,
    private readonly records?: SessionRecordReads,
  ) {}

  /** The resident sessions that run, in insertion order. */
  running(): SessionFacts[] {
    const out: SessionFacts[] = []
    for (const session of this.sessions.values()) {
      if (isRunningStatus(session.status)) out.push(sessionFactsOf(session))
    }
    return out
  }

  async readAll(): Promise<SessionFacts[]> {
    return (await this.required().all('facts.all')).map(subjectFacts)
  }

  async readByIds(sessionIds: Iterable<SessionId>): Promise<SessionFacts[]> {
    return [...(await this.required().resolve(sessionIds, 'facts.byIds')).values()].map(subjectFacts)
  }

  async readByIssue(worktreePath: string | null, issueId: IssueId | undefined): Promise<SessionFacts[]> {
    return (await this.required().issueMembers(worktreePath, issueId, 'facts.byIssue')).map(subjectFacts)
  }

  async readByWorktree(worktreePath: string | null): Promise<SessionFacts[]> {
    return (await this.required().underPath(worktreePath, 'facts.byWorktree')).map(subjectFacts)
  }

  async readByMachine(machineId: MachineId): Promise<SessionFacts[]> {
    return (await this.required().onMachine(machineId, 'facts.byMachine')).map(subjectFacts)
  }

  /** Sessions in one of these statuses. */
  async readWithStatuses(statuses: readonly SessionFacts['status'][]): Promise<SessionFacts[]> {
    return (await this.required().withStatuses(statuses, 'facts.withStatuses')).map(subjectFacts)
  }

  /** Sessions whose id starts with a short id. */
  async readByIdPrefix(prefix: string): Promise<SessionFacts[]> {
    return (await this.required().withIdPrefix(prefix, 'facts.byIdPrefix')).map(subjectFacts)
  }

  /** The candidates for a birth ref (see `SessionRecords.birthRefCandidates`). */
  async readBirthRefCandidates(ref: { seq: number; letter: string } | { draft: number }): Promise<SessionFacts[]> {
    return (await this.required().birthRefCandidates(ref, 'facts.birthRef')).map(subjectFacts)
  }

  /** The sessions spawned by any of these sessions. */
  async readChildren(parentIds: readonly SessionId[]): Promise<SessionFacts[]> {
    return (await this.required().childrenOf(parentIds, 'facts.children')).map(subjectFacts)
  }

  private required(): SessionRecordReads {
    if (!this.records) throw new Error('SessionFactsReader: no session records to read from')
    return this.records
  }

  /**
   * Every RESIDENT session's facts, in insertion order: the running ones and
   * those in use (POD-6160). Its last caller (the issue deck) waits for the
   * operator's decision to read `readAll()` instead.
   */
  all(): SessionFacts[] {
    const out: SessionFacts[] = []
    for (const session of this.sessions.values()) out.push(sessionFactsOf(session))
    return out
  }
}
