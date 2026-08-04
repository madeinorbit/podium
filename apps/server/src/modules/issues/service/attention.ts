import { randomUUID } from 'node:crypto'
import type { IssueId, IssueWire, SessionId, SessionMeta, UserId } from '@podium/model'
import {
  attributionOf,
  onBehalfOfUser,
  type CommandPrincipal,
  type SystemCommandPrincipal,
} from '../../../command-principal'
import { sessionsForIssue } from '../../../issue-util'
import type { IssueRow, Subscription } from '../../../store'
import type { IssueStore } from './core'
import type { IssueCrudModule } from './crud'
import type { IssueReportsModule } from './reads'
import { AUTO_ARCHIVE_READ_WINDOW_MS } from './types'

/**
 * Attention and subscriptions capability:
 * archive + the read-gated auto-archive sweep (#127), the session-attach /
 * draft-vessel flows (issue-as-workspace), and event subscriptions (Phase B).
 */
export class IssueAttentionModule {
  constructor(
    readonly store: IssueStore,
    private readonly crud: () => Pick<
      IssueCrudModule,
      | 'create'
      | 'update'
      | 'purgeEmptyDraft'
      | 'defer'
      | 'undefer'
      | 'setNeedsHuman'
      | 'clearNeedsHuman'
      | 'markIssueRead'
      | 'markIssueUnread'
      | 'setIssueTucked'
    >,
    private readonly hierarchy: () => {
      addDep(fromRef: string, toRef: string, type?: string): IssueWire
    },
    private readonly reports: () => Pick<IssueReportsModule, 'niceRef'>,
  ) {}

  defer(...args: Parameters<IssueCrudModule['defer']>): ReturnType<IssueCrudModule['defer']> {
    return this.crud().defer(...args)
  }

  undefer(...args: Parameters<IssueCrudModule['undefer']>): ReturnType<IssueCrudModule['undefer']> {
    return this.crud().undefer(...args)
  }

  setNeedsHuman(
    ...args: Parameters<IssueCrudModule['setNeedsHuman']>
  ): ReturnType<IssueCrudModule['setNeedsHuman']> {
    return this.crud().setNeedsHuman(...args)
  }

  clearNeedsHuman(
    ...args: Parameters<IssueCrudModule['clearNeedsHuman']>
  ): ReturnType<IssueCrudModule['clearNeedsHuman']> {
    return this.crud().clearNeedsHuman(...args)
  }

  markIssueRead(
    ...args: Parameters<IssueCrudModule['markIssueRead']>
  ): ReturnType<IssueCrudModule['markIssueRead']> {
    return this.crud().markIssueRead(...args)
  }

  markIssueUnread(
    ...args: Parameters<IssueCrudModule['markIssueUnread']>
  ): ReturnType<IssueCrudModule['markIssueUnread']> {
    return this.crud().markIssueUnread(...args)
  }

  setIssueTucked(
    ...args: Parameters<IssueCrudModule['setIssueTucked']>
  ): ReturnType<IssueCrudModule['setIssueTucked']> {
    return this.crud().setIssueTucked(...args)
  }
  /** Re-home a session onto another issue (agent self-organization).
   *  - `newSubissue`: create a child issue first (parent = the session's current
   *    issue, else `targetId`), then attach to it. Decomposition: the parent is
   *    not shippable without it.
   *  - `newSpinoff` (POD-85): create a TOP-LEVEL issue with a `discovered-from`
   *    edge back to the origin, then attach to it. For work discovered en route
   *    that the origin can close without — provenance, not containment.
   *  - else attach to `targetId` (self-attach is a no-op).
   *  After the move, an abandoned EMPTY draft (no attached sessions, no worktree,
   *  no children) is deleted. */
  attachSession(opts: {
    sessionId: SessionId
    targetId?: string
    newSubissue?: { title: string; origin: 'human' | 'agent' }
    newSpinoff?: { title: string; origin: 'human' | 'agent' }
    confirmRehome?: boolean
    principal?: Exclude<CommandPrincipal, { kind: 'system' }>
  }): IssueWire {
    const { getSessionIssueId, setSessionIssueId } = this.store.deps
    if (!getSessionIssueId || !setSessionIssueId) {
      throw new Error('attachSession unavailable: session registry hooks not injected')
    }
    if (opts.newSubissue && opts.newSpinoff) {
      throw new Error('attach takes --subissue or --spinoff, not both')
    }
    const prevId = getSessionIssueId(opts.sessionId)
    let target: IssueRow | undefined
    const newIssue = opts.newSubissue ?? opts.newSpinoff
    if (newIssue) {
      const prev = prevId ? this.store.rows.get(prevId) : undefined
      // A native subagent inherits its parent's relay, so an unconfirmed attach
      // could silently re-home the parent session [spec:SP-bab8].
      if (prev && !prev.draft && !opts.confirmRehome) {
        throw new Error(
          `attach blocked: this session already belongs to ${this.reports().niceRef(prev)} (a real issue), ` +
            'so this could re-home that session unexpectedly. A native subagent must not ' +
            'self-attach; its parent must attach it. For a deliberate top-level move, re-run ' +
            'with `--confirm-rehome`.',
        )
      }
      const title = newIssue.title.trim()
      if (!title) throw new Error(`${opts.newSubissue ? 'subissue' : 'spinoff'} title is empty`)
      const anchorId = prevId ?? (opts.targetId ? this.store.resolveRef(opts.targetId) : null)
      if (!anchorId) {
        throw new Error(
          `no ${opts.newSubissue ? 'parent' : 'origin'} for the new issue: session is unattached and no --id given`,
        )
      }
      const anchor = this.store.rowOrThrow(anchorId)
      const wire = this.crud().create({
        repoPath: anchor.repoPath,
        title,
        startNow: false,
        // Subissue = decomposition, nests under the anchor. Spinoff = a sibling
        // at top level; its provenance is the discovered-from edge below.
        ...(opts.newSubissue ? { parentId: anchorId } : {}),
        // Derived by the registry from the caller (#348) — never client-supplied.
        origin: newIssue.origin,
        // A session re-homes here and works out of it — it is a real, trackable
        // piece of work, so it is human-audience (visible on the board) even when
        // an agent created it (#198). The "agent cuts a human-facing issue" case.
        audience: 'human',
        ...(opts.principal
          ? {
              ownerUserId: onBehalfOfUser(opts.principal) ?? undefined,
              createdByActor: attributionOf(opts.principal).actor,
              createdByOnBehalfOf: attributionOf(opts.principal).onBehalfOf,
            }
          : {}),
      })
      if (opts.newSpinoff) this.hierarchy().addDep(wire.id, anchorId, 'discovered-from')
      target = this.store.rowOrThrow(wire.id)
    } else {
      if (!opts.targetId) throw new Error('attach needs --id <issue> or --subissue "<title>"')
      target = this.store.rowOrThrow(this.store.resolveRef(opts.targetId))
      // Re-homing off a REAL issue is blocked [spec:SP-8744]: it strands the old
      // issue session-less so it drops out of the sidebar. Only the draft→issue
      // flow (naming a fresh vessel) may move between issues; from a real issue
      // the sanctioned move is `--subissue`, which keeps the subtree intact.
      const prev = prevId && prevId !== target.id ? this.store.rows.get(prevId) : undefined
      if (prev && !prev.draft) {
        throw new Error(
          `attach blocked: this session already belongs to ${this.reports().niceRef(prev)} (a real issue). ` +
            'Reassigning a session to a different issue is disabled; for new work use ' +
            '`podium issue attach --subissue "<title>" --confirm-rehome` or file the issue ' +
            'for another agent.',
        )
      }
    }
    if (prevId === target.id) return this.store.toWire(target) // self-attach: no-op
    setSessionIssueId(opts.sessionId, target.id)
    this.store.emitEvent('issue.session_attached', target.id, {
      seq: target.seq,
      sessionId: opts.sessionId,
      ...(prevId ? { from: prevId } : {}),
      ...(opts.principal ? { attribution: attributionOf(opts.principal) } : {}),
    })
    // Clean up the abandoned draft vessel it came from, if now completely empty.
    if (prevId) this.deleteIfEmptyDraft(prevId)
    this.store.broadcastList()
    return this.store.toWire(this.store.rowOrThrow(target.id))
  }

  /** Delete `id` iff it is a draft with no LIVING attached sessions, no worktree
   *  and no children — the empty auto-created vessel left behind by an attach or
   *  by its last session dying. A session blocks deletion only while it can still
   *  produce work: exited or archived sessions don't count (hibernated ones DO —
   *  hibernation is an intentional park, the draft must survive it). Any dead
   *  sessions still pointing at the deleted issue are detached so nothing
   *  dangles. Returns true iff the issue was deleted. */
  reapIfEmptyDraft(id: string): boolean {
    const row = this.store.rows.get(id)
    if (!row || row.deletedAt || !row.draft || row.worktreePath) return false
    const hasChildren = [...this.store.rows.values()].some((r) => r.parentId === id)
    if (hasChildren) return false
    const attached = this.store.deps.listSessions().filter((s) => s.issueId === id)
    const blocking = attached.some((s) => !s.archived && s.status !== 'exited')
    if (blocking) return false
    // Detach the remaining dead sessions BEFORE deleting so their broadcasts
    // never reference a vanished issue.
    if (this.store.deps.setSessionIssueId) {
      for (const s of attached) this.store.deps.setSessionIssueId(s.sessionId, null)
    }
    this.crud().purgeEmptyDraft(id)
    return true
  }

  private deleteIfEmptyDraft(id: string): void {
    this.reapIfEmptyDraft(id)
  }

  /** Boot-time reconciliation: delete every leaked empty draft (same emptiness
   *  predicate as the kill-path reaper — sessions killed/removed before the
   *  reaper existed left orphaned "Draft" vessels behind). Returns the number
   *  of drafts reaped. */
  reapLeakedDrafts(): number {
    let n = 0
    for (const id of [...this.store.rows.keys()]) {
      if (this.store.rows.get(id)?.draft && this.reapIfEmptyDraft(id)) n++
    }
    return n
  }

  /** The auto-created vessel for a low-friction agent start: a draft, human-origin
   *  backlog issue with a placeholder title. The spawn flow stamps its id onto the
   *  new session. */
  createDraftFor(
    repoPath: string,
    agentKind?: string,
    id?: IssueId,
    ownership?: { ownerUserId: UserId; createdByActor: string; createdByOnBehalfOf: UserId },
  ): IssueWire {
    return this.crud().create({
      repoPath,
      title: 'Draft',
      startNow: false,
      draft: true,
      origin: 'human',
      ...ownership,
      ...(agentKind ? { defaultAgent: agentKind } : {}),
      ...(id ? { id } : {}),
    })
  }

  // ---- event subscriptions (event-subscriptions design, Phase B) ----

  /** Create a subscription. The subscriber (who is notified) and the source (what is
   *  watched) are resolved by the caller; here we mint the id/timestamp and default
   *  it enabled. `sourceRef` for an issue/session source is stored as given — an
   *  issue ref is resolved to its internal id so relationship/subject matching is
   *  stable across #seq churn. */
  subscriptionAdd(input: {
    subscriberKind: Subscription['subscriberKind']
    subscriberId: string
    event: string
    sourceKind: Subscription['sourceKind']
    sourceRef: string
    deliverNudge?: boolean
    deliverNotify?: boolean
    origin?: Subscription['origin']
  }): Subscription {
    const sub: Subscription = {
      id: `sub_${randomUUID()}`,
      subscriberKind: input.subscriberKind,
      subscriberId: input.subscriberId,
      event: input.event,
      sourceKind: input.sourceKind,
      sourceRef:
        input.sourceKind === 'issue' ? this.store.resolveRef(input.sourceRef) : input.sourceRef,
      deliverNudge: input.deliverNudge ?? true,
      deliverNotify: input.deliverNotify ?? false,
      origin: input.origin ?? 'custom',
      enabled: true,
      createdAt: this.store.now(),
    }
    this.store.deps.funnel.run({ write: () => this.store.deps.store.events.addSubscription(sub) })
    return sub
  }

  subscriptionRemove(id: string): { removed: boolean } {
    const existed = this.store.deps.store.events.listSubscriptions().some((s) => s.id === id)
    this.store.deps.funnel.run({ write: () => this.store.deps.store.events.removeSubscription(id) })
    return { removed: existed }
  }

  subscriptionList(filter?: { subscriberId?: string }): Subscription[] {
    return this.store.deps.store.events.listSubscriptions(filter)
  }

  /** Toggle a subscription on/off (Automations UI). Custom subscriptions only affect
   *  the additive dispatcher pass, so disabling one never touches the built-in
   *  handlers — it is safe and reversible. */
  subscriptionSetEnabled(id: string, enabled: boolean): { updated: boolean } {
    return this.store.deps.funnel.run({
      write: () => ({ updated: this.store.deps.store.events.setSubscriptionEnabled(id, enabled) }),
    })
  }

  subscriptionGet(id: string): Subscription | undefined {
    return this.store.deps.store.events.getSubscription(id)
  }

  archive(id: string): IssueWire {
    return this.crud().update(id, { archived: true })
  }

  /**
   * Read-gated auto-archive sweep (issue #127). Archive every issue that is
   * DONE (or otherwise closed), has been READ, and whose read happened at least
   * `AUTO_ARCHIVE_READ_WINDOW_MS` (7 days) ago. This declutters the sidebar (S1 hides
   * archived) while keeping the result reachable via the board's Archived filter.
   *
   * Read-gating is the point: a done-but-unread issue is left alone — the operator
   * hasn't seen the result yet, and *reading* it is what starts the seven-day clock
   * (see `computeUnread`: any activity after `readAt` re-flips it to unread).
   *
   * Cheap + idempotent: already-archived rows are skipped, the four cheap gates
   * (archived / closed / readAt-set / cutoff) run before the per-row session
   * lookup, and once a row archives the next sweep skips it (so its
   * `issue.auto_archived` event is emitted exactly once). `nowMs` is injectable so
   * tests can pin "now" (mirrors `staleList`); it defaults to the service clock.
   *
   * Returns the wires it archived (empty when nothing qualified).
   */
  sweepAutoArchive(
    nowMs: number = Date.parse(this.store.now()),
    principal?: SystemCommandPrincipal,
  ): IssueWire[] {
    const cutoffReadMs = nowMs - AUTO_ARCHIVE_READ_WINDOW_MS
    const out: IssueWire[] = []
    let sessionList: SessionMeta[] | undefined // fetched lazily — only if a row clears the cheap gates
    for (const row of this.store.rows.values()) {
      if (row.archived || row.deletedAt) continue // idempotent: never re-archive deleted work
      if (!this.store.isClosed(row) || row.parentId) continue // only closed top-level work ages out [spec:SP-6144]
      // "Read" is now a fact about a READER, so the sweep asks the broadcast
      // viewer (POD-1076). Behaviour is unchanged on a one-person instance; the
      // open question "auto-archived because WHO read it?" is POD-1136's, and it
      // is now askable because the value has an owner.
      const viewerReadAt = this.store.issueOverlay(row.id).readAt
      if (viewerReadAt == null) continue // never read → still unread, leave it
      const readMs = Date.parse(viewerReadAt)
      if (!Number.isFinite(readMs) || readMs > cutoffReadMs) continue // read too recently
      // Post-read activity re-marks the issue unread (the operator hasn't seen it):
      // honour that here so a re-touched done issue isn't archived out from under them.
      sessionList ??= this.store.deps.listSessions()
      const sessions = sessionsForIssue(row.worktreePath, sessionList, row.id)
      if (this.store.computeUnread(row, sessions)) continue
      out.push(this.autoArchive(row, principal))
    }
    return out
  }

  /**
   * Single-issue auto-archive for the fenced janitor command [POD-925].
   * Revalidates every durable + live precondition at apply time; the janitor
   * observation is only a proposal.
   */
  tryAutoArchiveObserved(
    observed: {
      issueId: string
      stage: string
      closedReason: string | null
      readerUserId: string
      archived: false
      deletedAt: null
    },
    nowMs: number = Date.parse(this.store.now()),
    principal?: SystemCommandPrincipal,
  ): 'applied' | 'precondition' | 'not-due' {
    const row = this.store.rows.get(observed.issueId)
    if (!row) return 'precondition'
    if (row.archived || row.deletedAt) return 'precondition'
    if (row.stage !== observed.stage || (row.closedReason ?? null) !== observed.closedReason) {
      return 'precondition'
    }
    // WHOSE read (POD-1229). `archived` is a SHARED column, so exactly one
    // reader may gate it — the viewer this service archives for. A proposal
    // naming anyone else is REFUSED rather than quietly evaluated against the
    // wrong person: that refusal is what makes "the janitor and the server must
    // ask the same principal" a checked fact instead of two constants that
    // happen to match. When `archived` becomes per-user (POD-1077), this
    // comparison becomes "the principal whose flag you are setting" and the
    // observation already carries it.
    if (observed.readerUserId !== this.store.broadcastViewer()) return 'precondition'
    const viewerReadAt = this.store.issueOverlay(row.id).readAt
    // NO compare-and-swap against an observed timestamp (POD-1229 removed it),
    // and deliberately no `viewerReadAt == null` guard here either: the two
    // cases the CAS caught are both already refused BELOW, and a second guard
    // that can be deleted without turning any test red is indistinguishable from
    // an absent one. A re-read moves this forward into the `not-due` window; a
    // mark-unread deletes the row, so `Date.parse(null ?? '')` is NaN and the
    // `Number.isFinite` check refuses it. Mutate either of those two lines and
    // `issues.test.ts`'s POD-1229 cases go red.
    if (!this.store.isClosed(row) || row.parentId) return 'precondition'
    const readMs = Date.parse(viewerReadAt ?? '')
    if (!Number.isFinite(readMs)) return 'precondition'
    if (readMs > nowMs - AUTO_ARCHIVE_READ_WINDOW_MS) return 'not-due'
    const sessions = this.store.sessionsFor(row)
    if (this.store.computeUnread(row, sessions)) return 'precondition'
    this.autoArchive(row, principal)
    return 'applied'
  }

  /** Archive `row` as the passive auto-archive sweep (issue #127). Reuses the same
   *  persist machinery `archive()` funnels through (sets archived + broadcasts
   *  issueUpdated & issuesChanged) but logs a DISTINCT `issue.auto_archived` event
   *  instead of the manual `issue.archived` — the activity log (S3) renders it as
   *  its own line, and nothing downstream mistakes a sweep for a user action. */
  private autoArchive(row: IssueRow, principal?: SystemCommandPrincipal): IssueWire {
    row.archived = true
    const wire = this.store.persist(row)
    this.store.emitEvent('issue.auto_archived', row.id, {
      seq: row.seq,
      readAt: this.store.issueOverlay(row.id).readAt,
      ...(principal ? { attribution: attributionOf(principal) } : {}),
    })
    // Cascade onto member sessions (issue #133): the sweep must not leave a
    // session-less worktree row behind, same as the manual archive path.
    this.cascadeArchiveSessions(row)
    // TODO(#127 seam): worktree cleanup hooks here. Auto-archive is where future
    // worktree/branch teardown for a finished issue will attach (see epic #101).
    // Deliberately NOT implemented now — archiving is purely a UI-declutter today.
    return wire
  }

  /** Cascade an issue archive onto its member sessions (issue #133). Archiving an
   *  issue must not leave its sessions live — that orphans a bare WORKTREE row in
   *  the sidebar where the issue used to be. Fires only on archive→true (manual,
   *  context-menu, and the S5 auto-archive sweep); un-archiving does NOT restore
   *  sessions. Reuses the session registry's own archive path (setSessionArchived →
   *  relay.setArchived) so each archived session persists + broadcasts. Skips
   *  already-archived sessions so a re-archive is a no-op with no redundant
   *  broadcast. */
  public cascadeArchiveSessions(row: IssueRow): void {
    const setArchived = this.store.deps.setSessionArchived
    if (!setArchived) return
    for (const s of this.store.sessionsFor(row)) {
      if (s.archived) continue
      setArchived(s.sessionId, true)
    }
  }

  /** Retire pending agent action offers on every member session when the issue
   *  closes (POD-290). Offers only clear on a user turn into THAT session, so a
   *  delegate that ends with `podium offer` leaves the decision live forever if
   *  the coordinator completes the merge through a different session. Closing is
   *  the explicit "work is finished" flip — clear standing offers so finished
   *  work cannot keep demanding attention. No-ops when the clear hook is absent
   *  (test deps) or a session has no offer. */
  public retireIssueOffers(row: IssueRow): void {
    const clearOffer = this.store.deps.clearSessionOffer
    if (!clearOffer) return
    for (const s of this.store.sessionsFor(row)) {
      if (!s.offer) continue
      clearOffer(s.sessionId)
    }
  }
}
