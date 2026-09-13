import {
  asUserId,
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
import {
  internalSessionRead,
  type SessionStatePrincipal,
  type SessionStateService,
} from './session-state/service'

/**
 * THE PROJECTION'S OWN IDENTITY when nobody asked for it [PDM-291].
 *
 * Every method here takes `forPrincipal?`, and in production NOTHING PASSES ONE:
 * the boot baseline, the volatile broadcast slice, the issue-member lookups and
 * every `sessionById` port are the server reading its own fleet. The two
 * user-facing surfaces that look like exceptions are not — `sessions.list`
 * re-filters the result through the model's `mayReadOwned` in
 * `modules/sessions/queries.ts`, and the read-toolkit procedures assert
 * ownership on the resolved id before they call it. So the fallback is reached
 * only by the server, and it now SAYS so instead of borrowing the earliest
 * admin's capability. The call-site-by-call-site audit that establishes it —
 * 80 production call sites, none of which passes a principal — is
 * `docs/plans/multi-user-epic/B/pdm-291-internal-read-audit.md` in the
 * podium-cloud repository, which is where this epic's plans live.
 */
const INTERNAL_PROJECTION_READ = internalSessionRead('sessions.view')

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
      const reader = forPrincipal ?? INTERNAL_PROJECTION_READ
      if (!(await this.ports.state.canReadSession(reader, sessionId, { issues: new Map(), grants: new Map() }))) {
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
    const reader = forPrincipal ?? INTERNAL_PROJECTION_READ
    const pass = await this.buildProjectionPass(candidates, forPrincipal)
    const visible = await this.ports.state.visibleSessions(
      reader, candidates.map(session => session.sessionId), pass,
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
    // A PASS WITH NO PRINCIPAL NOW WIRES NOBODY'S OVERLAY [PDM-424].
    //
    // It used to fall through to `internalOverlayUser()` — the earliest admin —
    // and that identity reached the CLIENTS, because `SessionRepository`
    // publishes the result of a principal-less pass as the one `entity:
    // 'session'` value every subscriber reads. The feed decides WHO receives a
    // row; it cannot give two recipients two payloads. So every member was shown
    // one administrator's `readAt`, derived `unread` and `snoozedUntil` over
    // their own sessions.
    //
    // `undefined` here leaves `overlays` empty and `wireSession` falls to
    // `NO_SESSION_USER_STATE`, which is exactly `NEUTRAL_SESSION_MARKS`: never
    // opened, never snoozed. The REAL values reach each person on the
    // `sessionMarks` sidecar, addressed to them by `sessionMarksRowId` and gated
    // by `feed-visibility.ts`'s `keyedUserOf`.
    //
    // NOT A NARROWING OF THE PRINCIPAL-FUL PATH. `list(principal)` and
    // `byId(id, principal)` still wire that principal's own overlay, unchanged —
    // this branch only stops inventing a viewer when the caller named none.
    //
    // WHAT WENT WITH IT. `internalOverlayUser()` was PDM-291's named answer to
    // "whose overlay does a principal-less pass wire", left deliberately in place
    // when that issue removed visibility's borrowing of the same identity. This
    // was its only caller, so the method is deleted rather than left standing —
    // a surviving resolver with no consumer reads as a fallback somebody may
    // reach for again, which is the shape PDM-295 rewrote comments across three
    // files to prevent. The question it answered is now answered by the split.
    //
    // THE READ IT REPLACED WAS POSITIONED HERE ON PURPOSE [PDM-291] and that
    // reasoning is recorded rather than discarded: `defaultPrincipal()` used to
    // be awaited exactly at this line, and moving it DOWN to where the overlay is
    // consumed inserted a fresh await into the middle of a pass that runs inside
    // a caller's transaction span, reopening the interleaving window
    // `lifecycle-runtime-fold.test.ts`'s site 7 catches — a
    // `StaleIssueRevisionError: expected revision 1, found 2` three frames away
    // from anything this file mentions (measured: 3 runs failed with the read
    // moved down, 3 passed with it here). Removing the await entirely cannot
    // reopen that window; adding one back below can, so do not.
    // RESOLVED FIRST, BEFORE ANY OTHER READ IN THIS METHOD, and that position is
    // load-bearing [PDM-291] — and REMOVING it breaks something PDM-291 did not
    // name, by a mechanism nobody has established yet: see
    // {@link internalOverlayUser} for the observed contrast and PDM-437 for where
    // the evidence stops. "The four probes that pin it" is how this line read
    // before the phase reviewer pointed out that probes pin a contrast, not a
    // cause. The answer is
    // deliberately NOT used for the overlay any more: a principal-less pass is
    // the BROADCAST, and one ledger value per session id reaches every
    // subscriber, so wiring any identity here shows one person's read marks and
    // snoozes to everybody. That was the defect [PDM-424].
    // THE SHORT-CIRCUIT IS PRESERVED EXACTLY as it was before PDM-424: a
    // principal-ful pass never resolved this identity and still does not, so it
    // pays nothing for a read it has no use for. Making the call unconditional
    // cost the reader-scoped budget two statements it had never paid — measured,
    // 6 -> 8, and reverted.
    const internalOverlayUser = forPrincipal ? undefined : await this.internalOverlayUser()
    // …and here is the whole repair: a principal-ful pass wires that principal's
    // own overlay, exactly as before; a principal-less one wires NOBODY's, and
    // `wireSession` falls to `NO_SESSION_USER_STATE` — which is
    // `NEUTRAL_SESSION_MARKS`. The real values reach each person on the
    // `sessionMarks` sidecar, addressed by `sessionMarksRowId` and gated by
    // `feed-visibility.ts`'s `keyedUserOf`.
    void internalOverlayUser
    const overlayUser = forPrincipal ? forPrincipal.userId : undefined
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
    const overlays = overlayUser
      ? await this.ports.state.overlaySnapshot(overlayUser, ids)
      : new Map<SessionId, SessionUserOverlay>()
    const machines = await this.ports.machines.factsSnapshot()
    const occupancy = new Map(sessions.map(s => [s.sessionId, this.ports.sessionOccupancyCount?.(s.sessionId)]))
    return { issues, grants, prefixes, queuedMessageCounts, overlays, machines, occupancy }
  }

  readonly wire = wireSession

  /**
   * A DEFINED OBSERVER FOR THE SESSION JANITOR — no longer a broadcast identity,
   * despite the name [PDM-424].
   *
   * IT USED TO CARRY THE DEFECT AND NOW DOES NOT, which is worth stating because
   * the method still resolves `firstAdminMemberId` and reads at a glance exactly
   * as it did when PDM-291's audit named it and PDM-295 declined to repair it.
   * The reason it was a defect was never this body. It was that the earliest
   * admin's overlay reached every client — and that happened through
   * `buildProjectionPass`, whose principal-less branch this method was never on.
   * PDM-424 measured the consumers before changing anything, and the brief that
   * sent it here named this method as THE site; it was not.
   *
   * WHAT ACTUALLY READS IT, and both are server-side judgements rather than
   * anything a member is shown:
   *   - `session-teardown.ts`'s `readerUserId` precondition and its `readAt`
   *     probe — the auto-archive observer, which needs a DEFINED person to have
   *     observed a session, not an arbitrary one.
   *   - `session-meta-ops.ts`'s `prepareIssueSessionDelete`, which builds metas
   *     ONLY to run `sessionsForIssue` for membership and DISCARDS the overlay.
   *     Wasteful, not a leak; narrowing it is not this issue's business.
   *
   * This is the class PDM-408 deliberately kept on the issue twin — its
   * `computeUnread`, `unreadFor` and auto-archive sweep still call
   * `broadcastViewer()` for the same reason. A janitor that observed "whoever
   * asked" would make archival depend on who happened to be connected.
   *
   * WHAT A MEMBER SEES no longer comes from here at all: the broadcast wires
   * nobody's overlay and the per-person values ride the `sessionMarks` sidecar.
   * If you are here because a member is seeing the wrong marks, this is not the
   * method — start at {@link buildProjectionPass}.
   */
  async broadcastViewer(): Promise<UserId> {
    return (await firstAdminMemberId(this.ports.store))
  }

  async principalForTrustedUser(userId: UserId): Promise<SessionStatePrincipal> {
    const role = await this.ports.store.users.roleOf(userId)
    if (!role) throw new Error(`refused: no active account for session-state user ${userId}`)
    return sessionStatePrincipalFor(userCommandPrincipal(userId, role))
  }

  /**
   * WHOSE per-user overlay a principal-less pass RESOLVES — and, since PDM-424,
   * no longer WIRES.
   *
   * PDM-291 named this rather than hiding it: a principal-less pass had to wire
   * somebody's overlay, the overlay is keyed by a user, so the single-user
   * fallback got a name. PDM-424 removed the CONSUMPTION — see
   * {@link buildProjectionPass}, where a principal-less pass now wires
   * `NO_SESSION_USER_STATE` and each person's real values ride the `sessionMarks`
   * sidecar. What a member is shown no longer comes from here.
   *
   * SO WHY IS THE READ STILL HERE. Because removing it breaks worktree adoption
   * three subsystems away — `relay.test.ts`'s two adoption cases and
   * `relay.machines.test.ts`'s remote one, where `branch` and `worktreePath` stay
   * null and a poll times out, with nothing logged and nothing thrown.
   *
   * WHAT IS OBSERVED. Outcomes, not causes. Overlay neutral in every row but the
   * first; run at THIS tip and at the base commit `879930b28`:
   *
   *                          tip          base
   *   await + admin value    passes       passes (unmodified base)
   *   await + neutral        passes       passes 3/3
   *   no await + neutral     FAILS 3/3    FAILS 2/2
   *   microtask + neutral    FAILS 3/3    not run
   *   in-memory + neutral    FAILS 3/3    not run
   *
   * WHAT THAT SUPPORTS IS ATTRIBUTION, AND ONLY THAT: the same contrast appears
   * at the base pin with PDM-424 absent, so whatever causes it is NOT introduced
   * by this issue.
   *
   * WHAT IT DOES NOT SUPPORT is any sentence of the form "the dependency is X" —
   * and an earlier version of this comment said exactly that ("the dependency is
   * on an awaited STORE round-trip at this position"). THE PHASE REVIEWER STRUCK
   * IT and was right: removing this read changes several things at once — an
   * await, a duration, a scheduling point, a store touch, and whatever that touch
   * warms or synchronises — and none of the probes separates them. The retained-
   * read row was meant to isolate value from await and does not, because a
   * retained read still touches the store; the `Promise.resolve()` row says a
   * microtask is not enough, which is a fact about that substitution rather than
   * about duration or scheduling.
   *
   * THE MECHANISM IS UNRESOLVED. PDM-437 holds the contrast, a three-command
   * reproduction, and an explicit statement of where the evidence stops. DO NOT
   * "clean up" this read until that issue is closed: its answer is unused and its
   * removal is not.
   *
   * TWO SENTENCES OF MINE HAVE BEEN STRUCK HERE, both recorded rather than edited
   * away because both are the confident, specific, survives-re-reading kind of
   * wrong sentence this epic keeps producing:
   *   1. "removing the await entirely cannot reopen that window; adding one back
   *      below can" — false, and I measured it false myself;
   *   2. the mechanism claim above, which I stated as a conclusion when I had a
   *      contrast, and which the phase reviewer struck.
   *
   * `undefined` — no admin yet, i.e. before bootstrap — is unchanged and is now
   * inert either way.
   */
  async internalOverlayUser(): Promise<UserId | undefined> {
    const member = await this.ports.store.users.earliestAdmin()
    return member ? asUserId(member.id) : undefined
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
