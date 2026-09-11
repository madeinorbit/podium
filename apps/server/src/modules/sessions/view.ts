import {
  firstAdminMemberId,
  NO_SESSION_USER_STATE,
  type SessionId,
  type SessionMeta,
  type SessionUserOverlay,
  type UserId,
  type IssueId,
} from '@podium/model'
import { formatSessionRef } from '@podium/protocol'
import { userCommandPrincipal } from '../../command-principal'
import { harnessCapabilitiesFor } from '../../harness-manifest'
import { isIssueMember } from '../../issue-util'
import type { SessionStore } from '../../store'
import type { IssueRow } from '../../store/types'
import type { MachineFactsSnapshot, MachinesService } from '../machines/service'
import { DEPLOYMENT, perf } from '../perf/registry'
import { granteesOf } from './session-state/grantees'
import type { Session, SessionDurableFields } from './session'
import { sessionStatePrincipalFor } from './session-state/registry'
import type { SessionStatePrincipal, SessionStateService } from './session-state/service'

/** Immutable inputs for one projection. No live service is reachable by wireSession. */
export interface ProjectionPass {
  queuedMessageCounts: ReadonlyMap<SessionId, number>
  issues: Map<string, IssueRow | null>
  grants: Map<string, string[]>
  prefixes: ReadonlyMap<string, string | null>
  overlays: ReadonlyMap<SessionId, SessionUserOverlay>
  machines: MachineFactsSnapshot
  occupancy: ReadonlyMap<SessionId, number | undefined>
}

export interface SessionViewPorts {
  sessions: Map<SessionId, Session>
  store: SessionStore
  machines: MachinesService
  state: SessionStateService
  /**
   * Room occupancy for a session (POD-1081). When provided, `clientCount` is
   * the occupancy size rather than the PTY attach-set size — attach remains for
   * frame delivery; who-is-watching is presence rooms.
   */
  sessionOccupancyCount?(sessionId: SessionId): number | undefined
}

/**
 * WHO ASKED FOR THE FULL PROJECTION — and, since POD-3857, an exhaustive list
 * of the places that still may.
 *
 * There is deliberately no `'unlabeled'` member and no default value on
 * {@link SessionView.list}. The label used to be optional with an
 * `'unlabeled'` fallback, and roughly forty internal call sites took it: the
 * perf phase then reported one 733 ms bucket 6.2 times a minute with nothing to
 * say about who caused it. Every internal caller now reads
 * `sessionFacts()` instead, and making the argument REQUIRED over a union with
 * no escape hatch is what keeps it that way — a new full-list caller cannot
 * compile without naming itself here, in a diff a reviewer sees.
 *
 *  - `bootstrap` — the boot ledger reconcile. This is the client-visible
 *    session baseline (`sync.changesSince` is served from it), so it is the
 *    projection by definition. Once per server start.
 *  - `rpc` — the `sessions.list` procedure. A client read, per request.
 *  - `listAllTool` — the superagent's `list_sessions` tool. Agent-facing and
 *    on demand; it reports each session's SNOOZE state, which lives in the
 *    per-user overlay and so exists only on the projection.
 */
export type SessionListCaller = 'bootstrap' | 'rpc' | 'listAllTool'

/** The single live-model → reader-scoped SessionMeta projection. */
export class SessionView {
  constructor(private readonly ports: SessionViewPorts) {}

  async list(
    forPrincipal: SessionStatePrincipal | undefined,
    caller: SessionListCaller,
  ): Promise<SessionMeta[]> {
    const startedAt = performance.now()
    try {
      return await this.project([...this.ports.sessions.values()], forPrincipal)
    } finally {
      perf.record('phase', 'sessionView.list', performance.now() - startedAt, DEPLOYMENT)
      perf.record('phase', `sessionView.list.${caller}`, performance.now() - startedAt, DEPLOYMENT)
    }
  }

  /**
   * The SESSIONS OF ONE ISSUE, without building the other 1100 [POD-1639].
   *
   * `sessionsForIssue(path, list(), id)` is the shape almost every issue mutation
   * wanted: a handful of member sessions. It got them by building the full
   * reader-scoped projection and discarding it — measured on the live corpus
   * (1582 issues / 1119 visible sessions), `cascadeArchiveSessions` found ZERO
   * members and still paid the whole pass, twice per archive.
   *
   * The narrowing is legitimate because membership is decided by two fields that
   * live on the session itself — `issueId` and `cwd` — and the projection copies
   * both through unchanged. So {@link isIssueMember} against the live objects
   * selects the same set the post-filter would, and only that set is visibility-
   * checked and wired. Visibility is NOT narrowed: the surviving members still go
   * through `canReadSession` for the same principal, so a caller sees exactly the
   * sessions it saw before.
   */
  async listForIssue(
    worktreePath: string | null,
    issueId: IssueId | undefined,
    forPrincipal?: SessionStatePrincipal,
  ): Promise<SessionMeta[]> {
    const startedAt = performance.now()
    try {
      const members = [...this.ports.sessions.values()].filter((session) =>
        isIssueMember(worktreePath, issueId, session),
      )
      return await this.project(members, forPrincipal)
    } finally {
      perf.record('phase', 'sessionView.listForIssue', performance.now() - startedAt, DEPLOYMENT)
    }
  }

  /**
   * ONE SESSION BY ID, without building the other 1100 [POD-1646].
   *
   * `list().find((s) => s.sessionId === id)` was spelled at 36 sites, several of
   * them on the authorization path — so a by-id lookup paid a full reader-scoped
   * pass on essentially every request. The narrowing is sound for the same
   * reason `listForIssue`'s is: the deciding field is the session's OWN id, and
   * `ports.sessions` is the very map `list()` enumerates, keyed by `sessionId`
   * at every writer. Visibility is NOT narrowed — the one candidate still goes
   * through `canReadSession` for the same principal, so a caller sees `undefined`
   * in exactly the cases the post-filter left it empty.
   */
  async byId(sessionId: SessionId, forPrincipal?: SessionStatePrincipal): Promise<SessionMeta | undefined> {
    const startedAt = performance.now()
    try {
      const session = this.ports.sessions.get(sessionId)
      if (!session) return undefined
      return (await this.project([session], forPrincipal))[0]
    } finally {
      perf.record('phase', 'sessionView.byId', performance.now() - startedAt, DEPLOYMENT)
    }
  }

  /**
   * A KNOWN SET of sessions by id, without wiring the rest [POD-2322].
   *
   * Candidates are selected in the live map's insertion order, exactly as
   * `list().filter(...)` would return them. Visibility and projection still
   * use the shared path; duplicate and absent ids add no work.
   */
  async byIds(sessionIds: Iterable<SessionId>, forPrincipal?: SessionStatePrincipal): Promise<SessionMeta[]> {
    const startedAt = performance.now()
    try {
      const wanted = new Set(sessionIds)
      if (wanted.size === 0) return []
      const candidates = [...this.ports.sessions.values()].filter((session) =>
        wanted.has(session.sessionId),
      )
      return await this.project(candidates, forPrincipal)
    } finally {
      perf.record('phase', 'sessionView.byIds', performance.now() - startedAt, DEPLOYMENT)
    }
  }

  /**
   * `byId(id)?.spawnedBy` WITHOUT THE WIRE [POD-1646].
   *
   * The authz sites (layout, fleet, settings, read-position) and the delegation
   * index want one string, not a `SessionMeta`. Wiring one costs the harness
   * manifest, the user overlay, the machine name and the display-ref resolution
   * — every one of them discarded here. `spawnedBy` is a plain field that
   * `toMeta` copies through unchanged (falsy stripped, which is the same
   * `undefined` optional chaining produced), so this returns what the wired
   * lookup returned, under the same visibility check.
   */
  async spawnedByOf(sessionId: SessionId, forPrincipal?: SessionStatePrincipal): Promise<string | undefined> {
    const startedAt = performance.now()
    try {
      const session = this.ports.sessions.get(sessionId)
      if (!session) return undefined
      const principal = forPrincipal ?? await this.defaultPrincipal()
      if (!principal) return undefined
      if (!(await this.ports.state.canReadSession(principal, sessionId, { issues: new Map(), grants: new Map() }))) {
        return undefined
      }
      return session.spawnedBy
    } finally {
      perf.record('phase', 'sessionView.spawnedByOf', performance.now() - startedAt, DEPLOYMENT)
    }
  }

  /** The reader-scoped projection over a candidate set — the body `list()`,
   *  `listForIssue()` and `byId()` share so the visibility rule and the memo
   *  lifetime have exactly one definition. */
  private async project(candidates: Session[], forPrincipal?: SessionStatePrincipal): Promise<SessionMeta[]> {
    const principal = forPrincipal ?? await this.defaultPrincipal()
    if (!principal) return []
    const pass = await this.buildProjectionPass(candidates, principal)
    const visible = await this.ports.state.visibleSessions(
      principal, candidates.map(session => session.sessionId), pass,
    )
    const readable = candidates.filter(session => visible.has(session.sessionId))
    if (readable.length === 0) return []
    return readable.map(session => this.wire(session, pass))
  }

  /** Build after any transaction writes; drafts supply the fields being committed. */
  async buildProjectionPass(
    sessions: readonly (SessionDurableFields & { sessionId: SessionId })[],
    forPrincipal?: SessionStatePrincipal,
  ): Promise<ProjectionPass> {
    const principal = forPrincipal ?? await this.defaultPrincipal()
    const ids = sessions.map(s => s.sessionId)
    const issueIds = [...new Set(sessions.flatMap(s =>
      [s.issueId, s.refIssueId].filter((id): id is IssueId => !!id),
    ))]
    const found = issueIds.length ? await this.ports.store.issues.getIssues(issueIds) : new Map<string, IssueRow>()
    const issues = new Map(issueIds.map(id => [id, found.get(id) ?? null]))
    const grants = new Map<string, string[]>()
    for (const kind of ['issue', 'session'] as const) {
      const resources = [...new Set(sessions.flatMap<string>(s =>
        kind === 'issue' ? (s.issueId ? [s.issueId] : []) : (!s.issueId ? [s.sessionId] : []),
      ))]
      if (!resources.length) continue
      const edges = await this.ports.store.grants.listForResources(kind, resources)
      for (const id of resources) grants.set(`${kind}:${id}`, granteesOf(edges.get(id) ?? []))
    }
    const paths = new Set(sessions.flatMap(s => {
      const issue = s.refIssueId && s.refLetter ? issues.get(s.refIssueId) : undefined
      return issue ? [issue.repoPath] : s.refDraft != null ? [s.cwd] : []
    }))
    const prefixes = new Map<string, string | null>()
    if (paths.size) {
      const prefixForPath = await this.ports.store.repos.prefixResolver()
      for (const path of paths) prefixes.set(path, prefixForPath(path))
    }
    const queuedMessageCounts = await this.ports.store.sync.queuedMessageCounts(ids)
    const overlays = principal
      ? await this.ports.state.overlaySnapshot(principal.userId, ids)
      : new Map<SessionId, SessionUserOverlay>()
    const machines = await this.ports.machines.factsSnapshot()
    const occupancy = new Map(sessions.map(s => [s.sessionId, this.ports.sessionOccupancyCount?.(s.sessionId)]))
    return { issues, grants, prefixes, queuedMessageCounts, overlays, machines, occupancy }
  }

  readonly wire = wireSession

  async broadcastViewer(): Promise<UserId> {
    return (await firstAdminMemberId(this.ports.store))
  }

  async principalForTrustedUser(userId: UserId): Promise<SessionStatePrincipal> {
    const role = await this.ports.store.users.roleOf(userId)
    if (!role) throw new Error(`refused: no active account for session-state user ${userId}`)
    return sessionStatePrincipalFor(userCommandPrincipal(userId, role))
  }

  async defaultPrincipal(): Promise<SessionStatePrincipal | undefined> {
    const member = await this.ports.store.users.earliestAdmin()
    const role = member?.role
    return role
      ? sessionStatePrincipalFor(userCommandPrincipal(member!.id, role))
      : undefined
  }

  async overlay(sessionId: SessionId): Promise<SessionUserOverlay> {
    return await this.ports.state.overlay((await this.broadcastViewer()), sessionId)
  }

  /**
   * THE ALLOCATION IS PREPARED AGAINST A DRAFT [POD-3330], and the returned
   * write assigns into that same draft inside the transaction. It reads the
   * caller's `issueId` — which the caller has just set on the draft and nowhere
   * else — so passing the live session here would decide against the PREVIOUS
   * attachment and allocate the wrong ref, or none.
   */
  async prepareRefAllocation(session: SessionDurableFields): Promise<(() => Promise<void>) | undefined> {
    if (session.refIssueId || session.refDraft != null) return
    const birthIssueId = session.issueId ?? null
    if (birthIssueId) {
      const issue = await this.ports.store.issues.getIssue(birthIssueId)
      if (issue) {
        return async () => {
          session.refLetter = await this.ports.store.issues.allocateSessionLetter(birthIssueId)
          session.refIssueId = birthIssueId
        }
      }
    }
    const repoId = await this.ports.store.repos.resolveRepoIdForPath(session.cwd)
    if (await this.ports.store.repos.prefixForRepoId(repoId) === null) return
    return async () => {
      session.refDraft = await this.ports.store.repos.nextDraftSeq(repoId)
    }
  }

}

/** Pure projection: only the session, its optional durable draft, and captured facts. */
export function wireSession(
  session: Session,
  pass: ProjectionPass,
  d: SessionDurableFields = session,
): SessionMeta {
  const meta = session.toMeta(pass.overlays.get(session.sessionId) ?? NO_SESSION_USER_STATE, d)
  const queuedMessageCount = pass.queuedMessageCounts.get(session.sessionId) ?? 0
  const occupancy = pass.occupancy.get(session.sessionId)
  const loginCondition = pass.machines.loginCondition(d.machineId, session.agentKind)
  const harnessCapabilities = harnessCapabilitiesFor(session.agentKind)
  let displayRef: string | undefined
  if (d.refIssueId && d.refLetter) {
    const issue = pass.issues.get(d.refIssueId)
    const prefix = issue && pass.prefixes.get(issue.repoPath)
    if (prefix && issue) displayRef = formatSessionRef({ prefix, seq: issue.seq, letter: d.refLetter })
  } else if (d.refDraft != null) {
    const prefix = pass.prefixes.get(d.cwd)
    if (prefix) displayRef = formatSessionRef({ prefix, draft: d.refDraft })
  }
  return {
    ...meta,
    ...(queuedMessageCount > 0 ? { queuedMessageCount } : {}),
    ...(occupancy !== undefined ? { clientCount: occupancy } : {}),
    machineName: pass.machines.name(d.machineId),
    ...(loginCondition ? { condition: loginCondition } : {}),
    ...(harnessCapabilities ? {
      harnessHandoff: harnessCapabilities.handoff,
      harnessPromptModeHints: harnessCapabilities.promptModeHints,
    } : {}),
    ...(d.refIssueId ? { refIssueId: d.refIssueId } : {}),
    ...(d.refLetter ? { refLetter: d.refLetter } : {}),
    ...(d.refDraft != null ? { refDraft: d.refDraft } : {}),
    ...(displayRef ? { displayRef } : {}),
  }
}
