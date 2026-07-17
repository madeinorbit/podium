import { randomUUID } from 'node:crypto'
import type { IssueWire, SessionMeta } from '@podium/protocol'
import { sessionsForIssue } from '../../../issue-util'
import type { IssueRow, Subscription } from '../../../store'
import { IssueServiceCrud } from './crud'
import { AUTO_ARCHIVE_READ_WINDOW_MS } from './types'

/**
 * IssueService layer 3 — attention & lifecycle housekeeping (issue #190 split):
 * archive + the read-gated auto-archive sweep (#127), the session-attach /
 * draft-vessel flows (issue-as-workspace), and event subscriptions (Phase B).
 */
export abstract class IssueServiceAttention extends IssueServiceCrud {
  /** Re-home a session onto another issue (agent self-organization).
   *  - `newSubissue`: create a child issue first (parent = the session's current
   *    issue, else `targetId`), then attach to it.
   *  - else attach to `targetId` (self-attach is a no-op).
   *  After the move, an abandoned EMPTY draft (no attached sessions, no worktree,
   *  no children) is deleted. */
  attachSession(opts: {
    sessionId: string
    targetId?: string
    newSubissue?: { title: string; origin: 'human' | 'agent' }
  }): IssueWire {
    const { getSessionIssueId, setSessionIssueId } = this.deps
    if (!getSessionIssueId || !setSessionIssueId) {
      throw new Error('attachSession unavailable: session registry hooks not injected')
    }
    const prevId = getSessionIssueId(opts.sessionId)
    let target: IssueRow | undefined
    if (opts.newSubissue) {
      const title = opts.newSubissue.title.trim()
      if (!title) throw new Error('subissue title is empty')
      const parentId = prevId ?? (opts.targetId ? this.resolveRef(opts.targetId) : null)
      if (!parentId) {
        throw new Error('no parent for the sub-issue: session is unattached and no --id given')
      }
      const parent = this.rowOrThrow(parentId)
      const wire = this.create({
        repoPath: parent.repoPath,
        title,
        startNow: false,
        parentId,
        // Derived by the registry from the caller (#348) — never client-supplied.
        origin: opts.newSubissue.origin,
        // A session re-homes here and works out of it — it is a real, trackable
        // piece of work, so it is human-audience (visible on the board) even when
        // an agent created it (#198). The "agent cuts a human-facing issue" case.
        audience: 'human',
      })
      target = this.rowOrThrow(wire.id)
    } else {
      if (!opts.targetId) throw new Error('attach needs --id <issue> or --subissue "<title>"')
      target = this.rowOrThrow(this.resolveRef(opts.targetId))
      // Re-homing off a REAL issue is blocked [spec:SP-8744]: it strands the old
      // issue session-less so it drops out of the sidebar. Only the draft→issue
      // flow (naming a fresh vessel) may move between issues; from a real issue
      // the sanctioned move is `--subissue`, which keeps the subtree intact.
      const prev = prevId && prevId !== target.id ? this.rows.get(prevId) : undefined
      if (prev && !prev.draft) {
        throw new Error(
          `attach blocked: this session already belongs to ${this.niceRef(prev)} (a real issue). ` +
            'Reassigning a session to a different issue is disabled; for new work use ' +
            '`podium issue attach --subissue "<title>"` or file the issue for another agent.',
        )
      }
    }
    if (prevId === target.id) return this.toWire(target) // self-attach: no-op
    setSessionIssueId(opts.sessionId, target.id)
    this.emitEvent('issue.session_attached', target.id, {
      seq: target.seq,
      sessionId: opts.sessionId,
      ...(prevId ? { from: prevId } : {}),
    })
    // Clean up the abandoned draft vessel it came from, if now completely empty.
    if (prevId) this.deleteIfEmptyDraft(prevId)
    this.broadcastList()
    return this.toWire(this.rowOrThrow(target.id))
  }

  /** Delete `id` iff it is a draft with no LIVING attached sessions, no worktree
   *  and no children — the empty auto-created vessel left behind by an attach or
   *  by its last session dying. A session blocks deletion only while it can still
   *  produce work: exited or archived sessions don't count (hibernated ones DO —
   *  hibernation is an intentional park, the draft must survive it). Any dead
   *  sessions still pointing at the deleted issue are detached so nothing
   *  dangles. Returns true iff the issue was deleted. */
  reapIfEmptyDraft(id: string): boolean {
    const row = this.rows.get(id)
    if (!row || row.deletedAt || !row.draft || row.worktreePath) return false
    const hasChildren = [...this.rows.values()].some((r) => r.parentId === id)
    if (hasChildren) return false
    const attached = this.deps.listSessions().filter((s) => s.issueId === id)
    const blocking = attached.some((s) => !s.archived && s.status !== 'exited')
    if (blocking) return false
    // Detach the remaining dead sessions BEFORE deleting so their broadcasts
    // never reference a vanished issue.
    if (this.deps.setSessionIssueId) {
      for (const s of attached) this.deps.setSessionIssueId(s.sessionId, null)
    }
    this.purgeEmptyDraft(id)
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
    for (const id of [...this.rows.keys()]) {
      if (this.rows.get(id)?.draft && this.reapIfEmptyDraft(id)) n++
    }
    return n
  }

  /** The auto-created vessel for a low-friction agent start: a draft, human-origin
   *  backlog issue with a placeholder title. The spawn flow stamps its id onto the
   *  new session. */
  createDraftFor(repoPath: string, agentKind?: string, id?: string): IssueWire {
    return this.create({
      repoPath,
      title: 'Draft',
      startNow: false,
      draft: true,
      origin: 'human',
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
      sourceRef: input.sourceKind === 'issue' ? this.resolveRef(input.sourceRef) : input.sourceRef,
      deliverNudge: input.deliverNudge ?? true,
      deliverNotify: input.deliverNotify ?? false,
      origin: input.origin ?? 'custom',
      enabled: true,
      createdAt: this.now(),
    }
    this.deps.funnel.run({ write: () => this.deps.store.events.addSubscription(sub) })
    return sub
  }

  subscriptionRemove(id: string): { removed: boolean } {
    const existed = this.deps.store.events.listSubscriptions().some((s) => s.id === id)
    this.deps.funnel.run({ write: () => this.deps.store.events.removeSubscription(id) })
    return { removed: existed }
  }

  subscriptionList(filter?: { subscriberId?: string }): Subscription[] {
    return this.deps.store.events.listSubscriptions(filter)
  }

  /** Toggle a subscription on/off (Automations UI). Custom subscriptions only affect
   *  the additive dispatcher pass, so disabling one never touches the built-in
   *  handlers — it is safe and reversible. */
  subscriptionSetEnabled(id: string, enabled: boolean): { updated: boolean } {
    return this.deps.funnel.run({
      write: () => ({ updated: this.deps.store.events.setSubscriptionEnabled(id, enabled) }),
    })
  }

  subscriptionGet(id: string): Subscription | undefined {
    return this.deps.store.events.getSubscription(id)
  }

  archive(id: string): IssueWire {
    return this.update(id, { archived: true })
  }

  /**
   * Read-gated auto-archive sweep (issue #127). Archive every issue that is
   * DONE (or otherwise closed), has been READ, and whose read happened at least
   * `AUTO_ARCHIVE_READ_WINDOW_MS` (24h) ago. This declutters the sidebar (S1 hides
   * archived) while keeping the result reachable via the board's Archived filter.
   *
   * Read-gating is the point: a done-but-unread issue is left alone — the operator
   * hasn't seen the result yet, and *reading* it is what starts the 24h clock
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
  sweepAutoArchive(nowMs: number = Date.parse(this.now())): IssueWire[] {
    const cutoffReadMs = nowMs - AUTO_ARCHIVE_READ_WINDOW_MS
    const out: IssueWire[] = []
    let sessionList: SessionMeta[] | undefined // fetched lazily — only if a row clears the cheap gates
    for (const row of this.rows.values()) {
      if (row.archived || row.deletedAt) continue // idempotent: never re-archive deleted work
      if (!this.isClosed(row)) continue // not done / not closed
      if (row.readAt == null) continue // never read → still unread, leave it
      const readMs = Date.parse(row.readAt)
      if (!Number.isFinite(readMs) || readMs > cutoffReadMs) continue // read too recently
      // Post-read activity re-marks the issue unread (the operator hasn't seen it):
      // honour that here so a re-touched done issue isn't archived out from under them.
      sessionList ??= this.deps.listSessions()
      const sessions = sessionsForIssue(row.worktreePath, sessionList, row.id)
      if (this.computeUnread(row, sessions)) continue
      out.push(this.autoArchive(row))
    }
    return out
  }

  /** Archive `row` as the passive auto-archive sweep (issue #127). Reuses the same
   *  persist machinery `archive()` funnels through (sets archived + broadcasts
   *  issueUpdated & issuesChanged) but logs a DISTINCT `issue.auto_archived` event
   *  instead of the manual `issue.archived` — the activity log (S3) renders it as
   *  its own line, and nothing downstream mistakes a sweep for a user action. */
  private autoArchive(row: IssueRow): IssueWire {
    row.archived = true
    const wire = this.persist(row)
    this.emitEvent('issue.auto_archived', row.id, { seq: row.seq, readAt: row.readAt })
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
  protected cascadeArchiveSessions(row: IssueRow): void {
    const setArchived = this.deps.setSessionArchived
    if (!setArchived) return
    for (const s of sessionsForIssue(row.worktreePath, this.deps.listSessions(), row.id)) {
      if (s.archived) continue
      setArchived(s.sessionId, true)
    }
  }
}
