import type { IssueComment, IssueWire, SessionMeta } from '@podium/protocol'
import type { PodiumSettings } from '@podium/runtime'
import { sessionsForIssue } from './issue-util'
import type { IssueService } from './modules/issues/service'
import type { SessionStore, Subscription } from './store'
import { NotificationArbiter } from './store/notification-facts'

/** One row read back from the durable event log (`podium_events`). */
export interface StewardEvent {
  id: number
  ts: string
  kind: string
  subject: string
  repoPath: string | null
  payload: unknown
}
type CausalPhasePayload = {
  phase?: string
  verdict?: string
  transitionId?: string
  transitionKind?: string
  provenance?: string
  observerGeneration?: number
  providerCursor?: { segmentId?: string; components?: Record<string, number> }
  turnEpoch?: number
  priorPhase?: string
  nextPhase?: string
}

/** Fully legacy rows remain routable until a v1 checkpoint exists. Once a row
 * carries any causal field, however, it must prove one accepted live terminal
 * edge; partial/bootstrap/replay/same-phase shapes fail closed. [spec:SP-cdb2] */
export function isAcceptedLiveTerminalEvent(e: StewardEvent): boolean {
  if (e.kind !== 'session.phase') return false
  const p = (e.payload ?? {}) as CausalPhasePayload
  const causal =
    p.transitionId !== undefined ||
    p.provenance !== undefined ||
    p.observerGeneration !== undefined ||
    p.providerCursor !== undefined ||
    p.turnEpoch !== undefined
  if (!causal) return true
  const terminal = (p.phase === 'idle' && p.verdict === 'done') || p.phase === 'errored'
  return (
    terminal &&
    p.provenance === 'live' &&
    p.transitionKind === 'turn_terminal' &&
    typeof p.transitionId === 'string' &&
    p.transitionId.length > 0 &&
    Number.isInteger(p.observerGeneration) &&
    (p.observerGeneration ?? 0) > 0 &&
    Number.isInteger(p.turnEpoch) &&
    (p.turnEpoch ?? 0) > 0 &&
    typeof p.providerCursor?.segmentId === 'string' &&
    p.priorPhase !== p.nextPhase &&
    p.nextPhase === p.phase
  )
}

/**
 * Event kind → coalescing key(s). Events sharing a key in one poll are handled
 * as ONE batch; kinds with no rule (or a rule returning undefined) are consumed
 * silently (the cursor moves past them). Pure and data-like so rules are
 * inspectable/testable in isolation. A rule may return several keys — one event
 * can fan out to multiple handlers with different audiences (e.g. a closed child
 * both unblocks dependents AND nudges the parent-issue sessions).
 *
 * This is the routing half of the subscription model (see the design at
 * docs/internal/superpowers/specs/2026-07-07-event-subscriptions-design.md): each
 * `parentnudge:<group>:<parentId>` key selects a default child→parent
 * subscription in CHILD_PARENT_SUBS. New child→parent notifications are a data
 * entry there plus a rule line here — no new handler.
 *
 * Session-spawner edge (M4 / POD-904, docs/agent-comms-target.html §07b):
 * `sessionparentnudge:<group>:<childSessionId>` is the SESSION→SESSION twin of
 * issue parentnudge. Parent is resolved from the child's `spawnedBy =
 * session:<parentId>` (not an issue parentId). Delivery carries wake rights so
 * a parked parent resumes (POD-279) — see handleSessionParentNudge.
 *
 * Follow-up rule slots (NOT this phase):
 * - session.* semantic events (started/finished/errored) → subscription delivery
 * - a periodic tidy tick (stale/doctor sweeps)
 */
export const TRIGGER_RULES: Record<string, (e: StewardEvent) => string | string[] | undefined> = {
  'issue.closed': (e) => {
    const unblock = `unblock:${e.repoPath ?? ''}`
    const parentId = (e.payload as { parentId?: string } | null)?.parentId
    return parentId ? [unblock, `parentnudge:closed:${parentId}`] : unblock
  },
  'issue.ready': (e) => `unblock:${e.repoPath ?? ''}`,
  'issue.stage_changed': (e) => {
    // Only a transition INTO review, and only when the mover has a parent to tell.
    const p = e.payload as { to?: string; parentId?: string } | null
    return p?.to === 'review' && p.parentId ? `parentnudge:review:${p.parentId}` : undefined
  },
  // Deterministic ack fallback (#237) [spec:SP-34d7 acks]: a session that
  // settles (finished/errored) with delivered-but-unacked messages triggers one
  // system notification per sender, so the sender ALWAYS learns the outcome.
  // M4 / POD-904: ALSO fan out a session-parent wake (resolved via spawnedBy in
  // the handler — pure rules cannot look up sessions). Keep ackfallback always.
  'session.phase': (e) => {
    const p = e.payload as { phase?: string; verdict?: string } | null
    if (p?.phase === 'idle' && p.verdict === 'done') {
      return isAcceptedLiveTerminalEvent(e)
        ? [`ackfallback:${e.subject}`, `sessionparentnudge:done:${e.subject}`]
        : `ackfallback:${e.subject}`
    }
    if (p?.phase === 'errored') {
      return isAcceptedLiveTerminalEvent(e)
        ? [`ackfallback:${e.subject}`, `sessionparentnudge:errored:${e.subject}`]
        : `ackfallback:${e.subject}`
    }
    return undefined
  },
  // Child process gone (exit-without-report half of §09-D). Handler skips when
  // the child already settled done/errored (shared settle fact) or has no
  // session-spawner parent.
  'session.exited': (e) =>
    (e.payload as { causalCheckpoint?: boolean } | null)?.causalCheckpoint
      ? undefined
      : `sessionparentnudge:exited:${e.subject}`,
  'issue.needs_human': (e) => {
    // Always leave the breadcrumb; ALSO notify the parent when the child has one.
    const breadcrumb = `needshuman:${e.subject}`
    const parentId = (e.payload as { parentId?: string } | null)?.parentId
    return parentId ? [breadcrumb, `parentnudge:needs_human:${parentId}`] : breadcrumb
  },
}

/** A seeded default child→parent subscription: subscriber = the child's parent,
 *  source = 'my-children', delivery = a durable comment + a one-line nudge. Adding
 *  a new child→parent notification is a data entry here, not a new handler. */
interface ChildParentSub {
  /** Colon-anchored marker prefix for the parent comment (dedup + replay-safe). */
  marker: (childSeq: number) => string
  /** The excerpt appended to the marker (agent-authored, first line, capped).
   *  `childComments` is the child's thread, fetched by the caller — comment
   *  bodies no longer ride IssueWire (#175). */
  excerpt: (e: StewardEvent, child: IssueWire | undefined, childComments: IssueComment[]) => string
  /** The single-line nudge; `counts` is meaningful for close, ignored otherwise. */
  nudge: (childSeq: number, counts: { remaining: number; total: number }) => string
}

const NUDGE_TAIL = 'See the steward comment, or run: podium issue prime'
const firstLineCapped = (s: string): string => (s.split('\n')[0] ?? '').slice(0, 200).trim()

/** The single-line nudge a stored subscription delivers. Deliberately generic and
 *  backtick-free (defense in depth, like the fixed handlers) — a per-subscription
 *  message template is Phase C. First-line-capped so a subject can never inject a
 *  newline. */
function subscriptionNudge(sub: Subscription, e: StewardEvent): string {
  return firstLineCapped(
    `Subscription: ${sub.event} fired for ${e.subject}. Run: podium issue prime`,
  ).replace(/`/g, '')
}

/** The external notification (ntfy/Telegram) a stored subscription delivers when its
 *  `notify` switch is on (#470) [spec:SP-17db]. Phone-shaped, not agent-shaped: it
 *  says what fired, not what to run — the CLI instructions belong in the nudge. */
export function subscriptionNotice(
  sub: Subscription,
  e: StewardEvent,
): { title: string; body: string } {
  return {
    title: `Podium: ${sub.event}`,
    body: firstLineCapped(`${sub.event} fired for ${e.subject}`),
  }
}

export const CHILD_PARENT_SUBS: Record<string, ChildParentSub> = {
  closed: {
    marker: (s) => `Child #${s} closed:`,
    excerpt: (_e, child, childComments) => firstLineCapped(completionNote(child, childComments)),
    nudge: (s, c) =>
      `Child issue #${s} closed — ${c.remaining} of ${c.total} children remain. ${NUDGE_TAIL}`,
  },
  review: {
    marker: (s) => `Child #${s} in review:`,
    excerpt: (_e, child, childComments) => firstLineCapped(completionNote(child, childComments)),
    nudge: (s) => `Child issue #${s} moved to review — ready for your look. ${NUDGE_TAIL}`,
  },
  needs_human: {
    marker: (s) => `Child #${s} needs a human:`,
    excerpt: (e) =>
      firstLineCapped(String((e.payload as { question?: string } | null)?.question ?? '')),
    nudge: (s) => `Child issue #${s} needs a human. ${NUDGE_TAIL}`,
  },
}

/**
 * Session-spawner child→parent wake groups (M4 / POD-904). Sibling of
 * CHILD_PARENT_SUBS for the SESSION→SESSION edge (`spawnedBy = session:<id>`).
 * No issue comment — the parent may be parked with no live issue surface; the
 * nudge itself is the signal and is delivered WITH wake rights via
 * sendTextWhenReady → queueText → resurrectSession.
 */
interface SessionParentSub {
  /** Single-line wake text: which child + terminal state. Backtick-free. */
  nudge: (childSessionId: string, childLabel: string) => string
}

const SESSION_PARENT_NUDGE_TAIL = 'Your child session needs attention.'

export const SESSION_PARENT_SUBS: Record<string, SessionParentSub> = {
  done: {
    nudge: (id, label) =>
      firstLineCapped(
        `Child session ${label} (${id}) finished (done). ${SESSION_PARENT_NUDGE_TAIL}`,
      ).replace(/`/g, ''),
  },
  errored: {
    nudge: (id, label) =>
      firstLineCapped(
        `Child session ${label} (${id}) errored. ${SESSION_PARENT_NUDGE_TAIL}`,
      ).replace(/`/g, ''),
  },
  exited: {
    nudge: (id, label) =>
      firstLineCapped(
        `Child session ${label} (${id}) exited without reporting. ${SESSION_PARENT_NUDGE_TAIL}`,
      ).replace(/`/g, ''),
  },
}

/** Parse `session:<parentSessionId>` from a child's spawnedBy; else undefined. */
export function sessionSpawnerParentId(spawnedBy: string | null | undefined): string | undefined {
  if (!spawnedBy || !spawnedBy.startsWith('session:')) return undefined
  const parentId = spawnedBy.slice('session:'.length)
  return parentId.length > 0 ? parentId : undefined
}

/**
 * The subscription-event kind(s) a raw log event qualifies as, or [] if it is not
 * subscribable (see the event-subscriptions design). Two derivations:
 *  - `session.phase` → a SEMANTIC session kind so subscriptions stay filter-free:
 *    idle+done → 'session.finished', errored → 'session.errored',
 *    needs_user → 'session.waiting'. All other phases (started/stopped/…) are ignored.
 *  - `issue.*` → the raw kind; `issue.stage_changed` ALSO yields the
 *    `issue.stage_changed:<to>` variant so a subscription can target `:review`.
 * Everything else (steward.* breadcrumbs, etc.) is not subscribable.
 */
export function subscriptionEventKinds(e: StewardEvent): string[] {
  if (e.kind === 'session.phase') {
    const p = e.payload as { phase?: string; verdict?: string } | null
    if ((p?.phase === 'idle' || p?.phase === 'errored') && !isAcceptedLiveTerminalEvent(e))
      return []
    if (p?.phase === 'idle' && p.verdict === 'done') return ['session.finished']
    if (p?.phase === 'errored') return ['session.errored']
    if (p?.phase === 'needs_user') return ['session.waiting']
    return []
  }
  if (e.kind === 'session.exited') {
    return (e.payload as { causalCheckpoint?: boolean } | null)?.causalCheckpoint
      ? []
      : ['session.exited']
  }
  if (e.kind.startsWith('issue.')) {
    if (e.kind === 'issue.stage_changed') {
      const to = (e.payload as { to?: string } | null)?.to
      return to ? ['issue.stage_changed', `issue.stage_changed:${to}`] : ['issue.stage_changed']
    }
    return [e.kind]
  }
  return []
}

/** Everything the steward needs, injected. `issues` is a narrow seam on purpose:
 *  mutations run in-process as author 'steward' today, and a capability-gated
 *  caller can replace the same surface later without touching the registry. */
export interface StewardDeps {
  store: Pick<
    SessionStore['events'],
    | 'listEventsSince'
    | 'getStewardState'
    | 'setStewardState'
    | 'appendEvent'
    | 'maxEventId'
    | 'listEnabledSubscriptions'
    | 'markDelivered'
  >
  facts: SessionStore['notificationFacts']
  /** Ledger read for the "already-communicated" suppression [POD-913, design
   *  §07b/§10]: has the producer already told a target directly, so the
   *  steward's own nudge for the same fact would just be a duplicate? */
  messages: Pick<SessionStore['messages'], 'alreadyCommunicated'>
  issues: Pick<IssueService, 'get' | 'getMeta' | 'list' | 'addComment' | 'ancestorIds' | 'comments'>
  listSessions: () => SessionMeta[]
  /** Durable-queue a nudge into a session (relay.queueText). For live sessions
   *  this is next-turn delivery; for parked/hibernated/exited sessions with a
   *  resume ref it ALSO resurrects (wake rights). Issue-parentnudge deliberately
   *  filters to live/starting; session-parent wake does not — a parked parent
   *  must be woken (POD-904 / POD-279). */
  sendTextWhenReady: (sessionId: string, text: string, mutationId?: string) => void
  /** Ack-fallback seam (#237) [spec:SP-34d7 acks]: notify the senders of the
   *  settled session's delivered-but-unacked messages, with issue stage + last
   *  commit stitched in. Wired to MessageDeliveryService.systemAckFallback in
   *  the composition root; suppression = the acked_by null-check at query time. */
  messaging?: {
    ackFallback(
      sessionId: string,
      outcome: 'finished' | 'errored',
      notificationFact: { factKey: string; target: string },
    ): void
  }
  /** External notification seam (#470) [spec:SP-17db]: the delivery behind a
   *  subscription's `notify` switch, wired to NotifyService.notifyExternal in the
   *  composition root. Structurally typed (not the NotifyService type) so the
   *  steward's unit tests stay hermetic. Absent = notify is breadcrumb-only. */
  notify?: (notice: { title: string; body: string }) => void
  getSettings: () => PodiumSettings
  intervalMs?: number
  now?: () => string
}

const CURSOR_KEY = 'cursor'
const COMPLETION_NOTE_TAG = '[completion-note]'

/** The closed issue's latest completion-note comment body (tag stripped), else its
 *  title. `comments` is the issue's thread, fetched by the caller via
 *  IssueService.comments — bodies no longer ride IssueWire (#175). */
function completionNote(closed: IssueWire | undefined, comments: IssueComment[]): string {
  if (!closed) return ''
  const note = [...comments].reverse().find((c) => c.body.includes(COMPLETION_NOTE_TAG))?.body
  return (note ? note.replace(COMPLETION_NOTE_TAG, '').trim() : closed.title).trim()
}

/**
 * The steward's trigger queue: a poll loop over the durable event log that turns
 * issue events into deterministic actions (no LLM at this layer). P1 shape:
 *
 * - Poll, not push: every `intervalMs` (15s) read `podium_events` past the
 *   persisted cursor, group through TRIGGER_RULES, run one handler per key.
 * - Serialization: batches run sequentially on the single tick loop — that IS
 *   the per-repo serialization at P1; no extra locking exists or is needed.
 * - Cursor discipline: the cursor advances only AFTER the whole run's handlers
 *   completed, so a crash mid-run re-reads the same events. Handlers must
 *   therefore be idempotent-ish (the unblock handler dedups on its own comment).
 * - Never wedge: a throwing handler is logged and the cursor STILL advances —
 *   we drop a trigger rather than replay a poison event forever.
 * - Ships dark: the loop only acts while `settings.steward.enabled`, re-read
 *   every tick so a settings flip takes effect without a restart.
 */
export class StewardService {
  /** "Since the change" grace window for the already-communicated check
   *  (§07b): a producer's own message can land moments before OR after the
   *  observed transition event (send-then-close vs close-with-note-then-poke),
   *  so the ledger lookback starts a little earlier than the event itself.
   *  Bounded, not "ever" — an old message about a PRIOR transition on the same
   *  (issue, target) pair must never suppress a fresh one. */
  private static readonly COMMUNICATED_GRACE_MS = 5 * 60_000

  private timer: ReturnType<typeof setInterval> | undefined
  private readonly arbiter: NotificationArbiter

  constructor(private readonly deps: StewardDeps) {
    this.arbiter = new NotificationArbiter(deps.facts, () => this.now())
  }

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString()
  }

  /**
   * Context-aware suppression (POD-913 / design §07b "already-communicated",
   * §10 "context-aware"): before firing an automated nudge for a fact about
   * `subjectIssueId` to `target`, has the producer already told that target
   * directly since the triggering change? If so, the steward's notice is a
   * duplicate, not a fallback — suppress it. The producer's message may have
   * been addressed to the target session itself OR to the issue it's working
   * (either puts the content in the target's context), so both are checked.
   * `subjectIssueId` absent (e.g. a session-parent nudge for a child with no
   * bound issue) means there is nothing to look up — never suppress on
   * missing information.
   */
  private alreadyCommunicated(
    subjectIssueId: string | undefined,
    target: { sessionId?: string; issueId?: string },
    changeTs: string,
  ): boolean {
    if (!subjectIssueId) return false
    const changeMs = Date.parse(changeTs)
    // Fail open: an unparseable timestamp means "since" is unknowable, so this
    // is a no-op rather than a crash (drop-don't-wedge, matching every other
    // handler's guarantee) — never suppress on missing information.
    if (!Number.isFinite(changeMs)) return false
    const sinceIso = new Date(changeMs - StewardService.COMMUNICATED_GRACE_MS).toISOString()
    if (
      target.sessionId &&
      this.deps.messages.alreadyCommunicated(
        subjectIssueId,
        { kind: 'session', id: target.sessionId },
        sinceIso,
      )
    ) {
      return true
    }
    if (
      target.issueId &&
      this.deps.messages.alreadyCommunicated(
        subjectIssueId,
        { kind: 'issue', id: target.issueId },
        sinceIso,
      )
    ) {
      return true
    }
    return false
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? 15_000)
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** The cursor to read past, seeding/healing the persisted row when needed:
   *  - absent (first enable): seed to MAX(id) — the log accumulated while the
   *    steward ran dark, and weeks of stale events must never replay as fresh
   *    unblock comments/nudges. Persisted immediately so a crash right after
   *    doesn't re-open history.
   *  - corrupt (non-numeric): a NaN cursor would match nothing and never be
   *    rewritten (permanent silent wedge) — log and re-seed to MAX(id). */
  private resolveCursor(): number {
    const raw = this.deps.store.getStewardState(CURSOR_KEY)
    if (raw !== undefined) {
      const cursor = Number(raw)
      if (Number.isFinite(cursor)) return cursor
      console.warn(`[podium:steward] corrupt cursor ${JSON.stringify(raw)} — re-seeding to now`)
    }
    const seeded = this.deps.store.maxEventId()
    this.deps.store.setStewardState(CURSOR_KEY, String(seeded))
    return seeded
  }

  /** One poll: read past the cursor, coalesce, handle, then advance. Public so
   *  tests drive it directly instead of waiting on real timers. */
  async tick(): Promise<void> {
    if (!this.deps.getSettings().steward?.enabled) return
    // Cheap housekeeping even on an otherwise empty tick [spec:SP-ba61].
    this.arbiter.retireExpired(this.now())
    const cursor = this.resolveCursor()
    const events = this.deps.store.listEventsSince(cursor)
    if (events.length === 0) return
    // Coalesce: all events for the same key form one batch this poll.
    const batches = new Map<string, StewardEvent[]>()
    for (const e of events) {
      const keys = TRIGGER_RULES[e.kind]?.(e)
      if (!keys) continue // unmatched kind — consumed silently
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        const batch = batches.get(key) ?? []
        batch.push(e)
        batches.set(key, batch)
      }
    }
    // Deliveries must be durable BEFORE cursor advance [POD-925 / SP-c29e].
    // Any handler or subscription delivery failure holds the cursor so the next
    // poll re-reads the same window (handlers are idempotent / mutation-keyed).
    let deliveryFailed = false
    for (const [key, batch] of batches) {
      try {
        if (key.startsWith('unblock:')) await this.handleUnblock(batch)
        else if (key.startsWith('sessionparentnudge:')) {
          // key = sessionparentnudge:<group>:<childSessionId>; ids never contain ':'.
          const rest = key.slice('sessionparentnudge:'.length)
          const sep = rest.indexOf(':')
          this.handleSessionParentNudge(rest.slice(sep + 1), rest.slice(0, sep), batch)
        } else if (key.startsWith('parentnudge:')) {
          // key = parentnudge:<group>:<parentId>; ids never contain ':'.
          // ISSUE-parent edge (payload.parentId) — live/starting only, no wake.
          const rest = key.slice('parentnudge:'.length)
          const sep = rest.indexOf(':')
          await this.handleParentNudge(rest.slice(sep + 1), rest.slice(0, sep), batch)
        } else if (key.startsWith('needshuman:')) this.handleNeedsHuman(batch)
        else if (key.startsWith('ackfallback:')) {
          this.handleAckFallback(key.slice('ackfallback:'.length), batch)
        }
      } catch (err) {
        deliveryFailed = true
        console.warn(`[podium:steward] handler for ${key} failed:`, err)
      }
    }
    // Second pass: the durable subscription model over the SAME polled events. The
    // hard-coded rules above are the seeded defaults; stored subscriptions layer on
    // top without disturbing them. Dedup is per (subscription, event) via the store,
    // so a cursor-rewind replay re-matches but never re-delivers.
    try {
      this.dispatchSubscriptions(events)
    } catch (err) {
      deliveryFailed = true
      console.warn('[podium:steward] subscription dispatch failed:', err)
    }
    // Retire after dispatch so the close transition itself can be announced, but
    // no recipient-scoped fact for the closed issue survives the tick.
    const closedIssues = new Set(
      events.filter((e) => e.kind === 'issue.closed').map((e) => e.subject),
    )
    for (const issueId of closedIssues) this.arbiter.retireByIssue(issueId)
    // Condition-clear retirement (POD-890 / POD-908) [spec:SP-ba61]: when the
    // underlying condition ends, free the (fact,target) so a later genuine edge
    // re-fires — without shortening the 24h cross-producer TTL ceiling.
    this.retireClearedConditions(events)
    if (deliveryFailed) {
      console.warn('[podium:steward] holding cursor — delivery failed; will retry the same window')
      return
    }
    this.deps.store.setStewardState(CURSOR_KEY, String(events[events.length - 1]!.id))
  }

  /**
   * Retire arbiter facts whose condition no longer holds, using the last
   * observed transition per subject in this poll (so settle-then-leave in one
   * tick retires; leave-then-settle keeps the fresh claim).
   *
   * Fact map (what each clear retires):
   * - session leaves idle/errored → `settle:<sid>` (ackfallback),
   *   `sessionparentnudge:settle:<sid>:` (legacy per-event prefix, POD-921)
   *   NOT `sessionparentnudge:phase-reported:<sid>` — that sticky is
   *   once-until-parent-ack (POD-917/POD-923); leave-idle must not re-arm it.
   * - issue leaves review → `parentnudge:review:<parentId>:<seq>`,
   *   `sub:issue.stage_changed:review:<issueId>`,
   *   `sub:issue.stage_changed:<issueId>`
   * - issue needs_human cleared → `parentnudge:needs_human:<parentId>:<seq>`,
   *   `sub:issue.needs_human:<issueId>`
   */
  private retireClearedConditions(events: StewardEvent[]): void {
    const lastPhaseBySession = new Map<string, StewardEvent>()
    for (const e of events) {
      if (e.kind === 'session.phase') lastPhaseBySession.set(e.subject, e)
    }
    for (const [sessionId, e] of lastPhaseBySession) {
      const phase = (e.payload as { phase?: string } | null)?.phase
      // Settled conditions that claim settle/sessionparent facts are idle and
      // errored. Any other phase means the session left that condition.
      if (phase && phase !== 'idle' && phase !== 'errored') {
        this.retireSessionSettledFacts(sessionId)
      }
    }

    for (const e of events) {
      if (e.kind === 'issue.stage_changed') {
        const p = e.payload as {
          from?: string
          to?: string
          parentId?: string
          seq?: number
        } | null
        if (p?.from === 'review' && p.to !== 'review') {
          this.retireIssueReviewFacts(e.subject, p)
        }
      } else if (e.kind === 'issue.needs_human_cleared') {
        const seq = (e.payload as { seq?: number } | null)?.seq
        this.retireNeedsHumanFacts(e.subject, seq)
      }
    }
  }

  /** Session left idle/errored — free ackfallback settle; NOT the parent-wake sticky. */
  private retireSessionSettledFacts(sessionId: string): void {
    const at = this.now()
    // Ack-fallback / settle fact (target is usually the session itself).
    this.arbiter.retireFactKey(`settle:${sessionId}`, at)
    // sessionparentnudge:phase-reported:<sid> is deliberately NOT retired here
    // (POD-917/POD-923). Leave-idle re-arm let phantom idle-cycles (zombie /
    // grok cwd-watch, POD-920) re-wake the parent. The sticky survives across
    // cycles and is cleared only when the parent acknowledges (MessageGate
    // awaitAgent observes settled → retireNotificationFact).
    // Legacy per-event settle instances (pre-POD-921 `…:<eventId>` keys). No
    // longer written; retired here to reap any that predate the deploy.
    this.arbiter.retireFactKeyPrefix(`sessionparentnudge:settle:${sessionId}:`, at)
  }

  /** Issue left review — free review parentnudge + stage_changed sub facts. */
  private retireIssueReviewFacts(issueId: string, p: { parentId?: string; seq?: number }): void {
    const at = this.now()
    if (p.parentId != null && p.seq != null) {
      this.arbiter.retireFactKey(`parentnudge:review:${p.parentId}:${p.seq}`, at)
    }
    this.arbiter.retireFactKey(`sub:issue.stage_changed:review:${issueId}`, at)
    this.arbiter.retireFactKey(`sub:issue.stage_changed:${issueId}`, at)
  }

  /** needs_human cleared — free needs_human parentnudge + sub facts. */
  private retireNeedsHumanFacts(issueId: string, seq: number | undefined): void {
    const at = this.now()
    const parentId = this.deps.issues.getMeta(issueId)?.parentId
    if (parentId != null && seq != null) {
      this.arbiter.retireFactKey(`parentnudge:needs_human:${parentId}:${seq}`, at)
    }
    this.arbiter.retireFactKey(`sub:issue.needs_human:${issueId}`, at)
  }

  /**
   * Match each polled event against the enabled stored subscriptions and deliver.
   * Per-subscription try/catch keeps the same drop-don't-wedge guarantee as the
   * fixed handlers — one bad subscription never stalls the queue or blocks the
   * cursor advance.
   */
  private dispatchSubscriptions(events: StewardEvent[]): void {
    const subs = this.deps.store.listEnabledSubscriptions()
    if (subs.length === 0) return
    const sessions = this.deps.listSessions()
    for (const e of events) {
      const kinds = subscriptionEventKinds(e)
      if (kinds.length === 0) continue
      const isSession = e.kind === 'session.phase' || e.kind === 'session.exited'
      // Session events carry a sessionId subject; resolve its bound issue so an
      // issue/relationship source can match on the work, not the raw session id.
      const srcSession = isSession ? sessions.find((s) => s.sessionId === e.subject) : undefined
      const srcIssueId = isSession ? (srcSession?.issueId ?? null) : e.subject
      for (const sub of subs) {
        if (!kinds.includes(sub.event)) continue
        try {
          if (this.sourceMatches(sub, { isSession, subject: e.subject, srcIssueId }, sessions)) {
            this.deliverSubscription(sub, e, sessions)
          }
        } catch (err) {
          console.warn(`[podium:steward] subscription ${sub.id} failed:`, err)
        }
      }
    }
  }

  /** Does the subscription's `source` resolve to include this event's subject?
   *  - session source: exact sessionId (session events only).
   *  - issue source: the event issue itself, or (for session events) the session's
   *    bound issue.
   *  - relationship source: resolved against the SUBSCRIBER's issue — 'my-children'
   *    (event issue's parent is the subscriber) / 'my-subtree' (subscriber is an
   *    ancestor). 'my-blockers'/'my-parent' are not yet resolvable here (TODO). */
  private sourceMatches(
    sub: Subscription,
    ev: { isSession: boolean; subject: string; srcIssueId: string | null },
    sessions: SessionMeta[],
  ): boolean {
    if (sub.sourceKind === 'session') {
      return ev.isSession && sub.sourceRef === ev.subject
    }
    if (sub.sourceKind === 'issue') {
      return ev.srcIssueId != null && sub.sourceRef === ev.srcIssueId
    }
    // relationship
    if (ev.srcIssueId == null) return false
    const anchor = this.subscriberIssueId(sub, sessions)
    if (!anchor) return false
    if (sub.sourceRef === 'my-children') {
      return this.deps.issues.getMeta(ev.srcIssueId)?.parentId === anchor
    }
    if (sub.sourceRef === 'my-subtree') {
      return this.deps.issues.ancestorIds(ev.srcIssueId).includes(anchor)
    }
    // my-blockers / my-parent: not trivially resolvable at this layer yet.
    return false
  }

  /** The issue a subscription's relationship source is anchored on: the subscriber
   *  issue itself, or (for a session subscriber) that session's bound issue. */
  private subscriberIssueId(sub: Subscription, sessions: SessionMeta[]): string | undefined {
    if (sub.subscriberKind === 'issue') return sub.subscriberId
    return sessions.find((s) => s.sessionId === sub.subscriberId)?.issueId ?? undefined
  }

  /** Deliver a matched subscription exactly once (markDelivered dedup). nudge →
   *  the subscriber's live/starting non-shell sessions (minus the causer, #116);
   *  notify → a durable `steward.notify` breadcrumb AND an external push (#470)
   *  [spec:SP-17db] — the breadcrumb stays because it is the audit record the
   *  dedup and the event log are keyed on; the push is what the switch's label
   *  ("Send an external notification") has always promised.
   *  The nudge stays single-line with no backticks, mirroring the fixed handlers. */
  private deliverSubscription(sub: Subscription, e: StewardEvent, sessions: SessionMeta[]): void {
    // Idempotent, replay-safe: only a NEWLY-recorded delivery proceeds.
    if (!this.deps.store.markDelivered(sub.id, e.id)) return
    const factKey = `sub:${sub.event}:${e.subject}`
    const issueId = this.subscriberIssueId(sub, sessions)
    // The event's own issue, for the already-communicated check below — the
    // raw event subject for an issue.* kind, or the source session's bound
    // issue for a session.* kind.
    const eventIssueId = e.kind.startsWith('issue.')
      ? e.subject
      : (sessions.find((s) => s.sessionId === e.subject)?.issueId ?? undefined)
    let subscriberClaimed = false
    if (sub.deliverNudge) {
      const causer = (e.payload as { causedBySessionId?: string } | null)?.causedBySessionId
      const text = subscriptionNudge(sub, e)
      const targets = this.subscriberNudgeTargets(sub, sessions).filter(
        (s) =>
          (s.status === 'live' || s.status === 'starting') &&
          s.agentKind !== 'shell' &&
          s.sessionId !== causer,
      )
      for (const s of targets) {
        // Already-communicated (§07b): targets here are already live/starting
        // (no wake-rights concern — see handleSessionParentNudge's note).
        // The external `notify` push below is scoped OUT deliberately: its
        // audience is a human off in the world, not an agent's transcript
        // context, so "already in context" doesn't apply to it.
        if (this.alreadyCommunicated(eventIssueId, { sessionId: s.sessionId, issueId }, e.ts)) {
          continue
        }
        if (this.arbiter.isClaimed(factKey, s.sessionId)) continue
        // Durable delivery before claim [POD-925].
        this.deps.sendTextWhenReady(s.sessionId, text, factKey)
        const claimed = this.arbiter.claim(factKey, s.sessionId, {
          source: `subscription:${sub.id}`,
          issueId,
        })
        if (!claimed) continue
        // The claim authorizes deliverNotify below for this same subscriber.
        if (s.sessionId === sub.subscriberId) subscriberClaimed = true
      }
    }
    // A session subscriber's single claim authorizes both configured delivery
    // channels from this producer; issue notifications claim the issue target.
    if (
      sub.deliverNotify &&
      (subscriberClaimed ||
        this.arbiter.claim(factKey, sub.subscriberId, {
          source: `subscription:${sub.id}`,
          issueId,
        }))
    ) {
      this.deps.store.appendEvent({
        ts: this.now(),
        kind: 'steward.notify',
        subject: sub.subscriberId,
        repoPath: e.repoPath,
        payload: {
          subscriptionId: sub.id,
          event: sub.event,
          of: e.id,
          sourceKind: e.kind,
          eventSubject: e.subject,
        },
      })
      // The push itself is fire-and-forget (the pushers log their own failures) —
      // but a thrown notifier must not cost the caller its delivery record.
      try {
        this.deps.notify?.(subscriptionNotice(sub, e))
      } catch (err) {
        console.warn(`[podium:steward] notify for subscription ${sub.id} failed:`, err)
      }
    }
  }

  /** The sessions a subscriber's nudge reaches: the one session for a `session`
   *  subscriber, or the member sessions of an `issue` subscriber's worktree (same
   *  no-resurrect/no-shell filtering the caller applies). */
  private subscriberNudgeTargets(sub: Subscription, sessions: SessionMeta[]): SessionMeta[] {
    if (sub.subscriberKind === 'session') {
      return sessions.filter((s) => s.sessionId === sub.subscriberId)
    }
    const issue = this.deps.issues.getMeta(sub.subscriberId)
    if (!issue) return []
    return sessionsForIssue(issue.worktreePath, sessions, issue.id)
  }

  /** For each newly-ready dependent: post an 'Unblocked by #<seq>' comment and
   *  nudge any live session working in its worktree. Idempotent via the comment
   *  dedup — a crash-replayed batch posts nothing twice. */
  private async handleUnblock(batch: StewardEvent[]): Promise<void> {
    for (const e of batch) {
      if (e.kind !== 'issue.ready') continue // issue.closed only coalesces the batch
      const closedSeq = (e.payload as { unblockedBy?: number } | null)?.unblockedBy
      if (closedSeq == null) continue
      // The session that closed the blocker already knows — skip self-nudge (#116).
      const causedBy = (e.payload as { causedBySessionId?: string } | null)?.causedBySessionId
      const dependent = this.deps.issues.getMeta(e.subject)
      if (!dependent) continue
      // Colon-anchored so '#5' never matches a prior '#55' comment. Single-server
      // assumption: this read-then-write dedup is a cross-process race — fine
      // while live is one server; revisit for multi-server.
      const marker = `Unblocked by #${closedSeq}:`
      // Comment bodies left IssueWire (#175) — dedup reads the thread directly.
      const already = this.deps.issues
        .comments(dependent.id)
        .some((c) => c.author === 'steward' && c.body.includes(marker))
      const closed = this.deps.issues
        .list(e.repoPath ?? dependent.repoPath)
        .find((w) => w.seq === closedSeq)
      if (!already) {
        const note = completionNote(closed, closed ? this.deps.issues.comments(closed.id) : [])
        this.deps.issues.addComment(dependent.id, 'steward', marker + ' ' + note)
      }
      // Nudge only live/starting agent sessions: queueText would RESURRECT a
      // parked session with a resume ref (the steward must never respawn agents),
      // and a shell would have the text typed into bash. The nudge itself stays
      // single-line with no backticks and no agent-authored note interpolated —
      // the note lives in the issue comment only.
      const targets = sessionsForIssue(
        dependent.worktreePath,
        this.deps.listSessions(),
        dependent.id,
      ).filter(
        (s) =>
          (s.status === 'live' || s.status === 'starting') &&
          s.agentKind !== 'shell' &&
          s.sessionId !== causedBy,
      )
      for (const s of targets) {
        // Already-communicated (§07b): the closer may have mailed the
        // dependent directly instead of relying on this nudge.
        if (
          this.alreadyCommunicated(
            closed?.id,
            { sessionId: s.sessionId, issueId: dependent.id },
            e.ts,
          )
        ) {
          continue
        }
        // Durable delivery BEFORE arbiter claim [POD-925]: claim-first suppressed
        // retry after a failed send and left no durable nudge on cursor rewind.
        const factKey = `unblock:${dependent.id}:${closedSeq}`
        if (this.arbiter.isClaimed(factKey, s.sessionId)) continue
        this.deps.sendTextWhenReady(
          s.sessionId,
          `Blocker #${closedSeq} closed — you are unblocked. See the steward comment on your issue, or run: podium issue prime`,
          factKey,
        )
        this.arbiter.claim(factKey, s.sessionId, {
          source: 'steward.unblock',
          issueId: dependent.id,
        })
      }
    }
  }

  /**
   * Session-spawner parent wake (M4 / POD-904) [docs/agent-comms-target.html §07b]:
   * when a child settles (done/errored) or exits without a prior settle report,
   * wake its SESSION parent (`spawnedBy = session:<parentId>`). Distinct from
   * handleParentNudge, which is ISSUE-parent oriented and deliberately does NOT
   * resurrect parked sessions.
   *
   * Dedup (POD-921 + POD-917/POD-923): one sticky
   * `sessionparentnudge:phase-reported:<childId>` fact until the parent ACKs,
   * not per event and not per leave-idle cycle. The first of done/errored/exited
   * claims it and wakes the parent; later ticks — terminal phase re-emitted with
   * a fresh event id every poll, exit trailing a prior done/errored, OR a
   * phantom idle-cycle (working→idle with no parent ack) — find it held and stay
   * silent. Cleared only when the parent observes the child settled
   * (MessageGate awaitAgent → retireNotificationFact), so a genuine later
   * re-completion re-fires once. An earlier per-EVENT key (`…:<eventId>`)
   * stormed because a terminal child yields a new event id each tick.
   *
   * Deliberately NOT already-communicated-suppressed (§07b, POD-913): this is
   * the WAKE-RIGHTS path — its entire purpose is resurrecting a PARKED parent
   * (sendTextWhenReady → queueText resurrects; the issue-parent nudges do not).
   * A message already in the ledger only proves the parent was TOLD, not that
   * it was WOKEN — a queued/wait-lifecycle message sitting unread in front of a
   * parked session does not resume it, so suppressing here on ledger content
   * alone could strand a parent parked forever (regressing the POD-279 fix
   * this milestone exists to deliver). Every other nudge site targets sessions
   * already live/starting, where that risk doesn't exist.
   */
  private handleSessionParentNudge(
    childSessionId: string,
    group: string,
    batch: StewardEvent[],
  ): void {
    const sub = SESSION_PARENT_SUBS[group]
    if (!sub) return
    const last = batch[batch.length - 1]
    if (!last) return
    const sessions = this.deps.listSessions()
    const child = sessions.find((s) => s.sessionId === childSessionId)
    // Prefer live meta; fall back to the event payload (session.exited stamps
    // spawnedBy so a race that drops the row still finds the parent).
    const spawnedBy = child?.spawnedBy ?? (last.payload as { spawnedBy?: string } | null)?.spawnedBy
    const parentId = sessionSpawnerParentId(spawnedBy)
    if (!parentId) return
    // Never self-wake (a mis-tagged spawnedBy).
    if (parentId === childSessionId) return
    const parent = sessions.find((s) => s.sessionId === parentId)
    // Parent must still exist as a session row (parked is fine — queueText wakes).
    // Unknown / fully deleted parent: nothing to wake.
    if (!parent) return
    if (parent.agentKind === 'shell') return
    const claimOpts = {
      source: `steward.session-parent-nudge:${group}`,
      issueId: parent.issueId ?? child?.issueId ?? undefined,
    }
    // Wake the parent EXACTLY ONCE until the parent acknowledges (POD-921 +
    // POD-917/POD-923). The sticky `phase-reported` fact is the single dedup
    // boundary: the first of done / errored / exited claims it and wakes the
    // parent; every later tick finds it held and stays silent. Covers the
    // terminal-phase re-emit storm (POD-921), exit-after-done (POD-907), AND
    // phantom leave-idle→re-settle cycles with no parent ack (POD-917 zombies).
    // Leave-idle does NOT retire this sticky; only parent await/observe does.
    // Durable delivery BEFORE claim [POD-925]; keyed per child, targeted per
    // parent. NB: do NOT key on the event id — a terminal session yields a new
    // id every poll, so a per-event key never dedups.
    const factKey = `sessionparentnudge:phase-reported:${childSessionId}`
    const rawLabel = child?.name || child?.title || childSessionId
    const label = firstLineCapped(rawLabel) || childSessionId
    // WAKE: durable delivery BEFORE claim [POD-925]. mutationId=factKey makes
    // crash-retry / multi-poll re-entry idempotent (queueText already-applied).
    if (this.arbiter.isClaimed(factKey, parentId)) return
    this.deps.sendTextWhenReady(parentId, sub.nudge(childSessionId, label), factKey)
    this.arbiter.claim(factKey, parentId, claimOpts)
  }

  /** A child event notifies its parent issue (default 'my-children' subscription):
   *  one steward comment per child (deduped on its colon-anchored marker, same
   *  lesson as unblock/#59) plus ONE coalesced nudge to the parent's live non-shell
   *  sessions. `group` selects the CHILD_PARENT_SUBS entry (closed / review /
   *  needs_human) that supplies the marker, comment excerpt, and nudge text. The
   *  excerpt lives in the COMMENT only; the nudge is a fixed single line.
   *  ISSUE-parent only — no parked-session wake (see handleSessionParentNudge). */
  private async handleParentNudge(
    parentId: string,
    group: string,
    batch: StewardEvent[],
  ): Promise<void> {
    const sub = CHILD_PARENT_SUBS[group]
    if (!sub) return
    const parent = this.deps.issues.getMeta(parentId)
    if (!parent) return
    let lastChildSeq: number | undefined
    // The event timestamp behind the coalesced nudge below, for the
    // already-communicated check (§07b) — "since the change" anchors on the
    // triggering event.
    let lastChangeTs: string | undefined
    // Sessions that caused an event in this batch already know — the single
    // coalesced nudge excludes all of them (#116). Collected across the whole
    // batch (before dedup) so a self-triggered event never self-nudges.
    const causedBy = new Set<string>()
    for (const e of batch) {
      const childSeq = (e.payload as { seq?: number } | null)?.seq
      if (childSeq == null) continue
      lastChildSeq = childSeq
      lastChangeTs = e.ts
      const causer = (e.payload as { causedBySessionId?: string } | null)?.causedBySessionId
      if (causer) causedBy.add(causer)
      // Colon-anchored so '#5' never matches a prior '#55' comment (see the
      // matching note on handleUnblock — same single-server dedup assumption).
      const marker = sub.marker(childSeq)
      // Comment bodies left IssueWire (#175) — dedup reads the thread directly.
      const already = this.deps.issues
        .comments(parent.id)
        .some((c) => c.author === 'steward' && c.body.includes(marker))
      if (already) continue
      const child = this.deps.issues
        .list(e.repoPath ?? parent.repoPath)
        .find((w) => w.seq === childSeq)
      // Empty excerpt (no note / question) → bare marker, no trailing space.
      // The marker keeps its colon so replay dedup still matches.
      const excerpt = sub.excerpt(e, child, child ? this.deps.issues.comments(child.id) : [])
      this.deps.issues.addComment(parent.id, 'steward', excerpt ? `${marker} ${excerpt}` : marker)
    }
    // Nudge when this batch had a child event. Comment may already exist from a
    // prior cycle of the same child (review→out→review / needs_human clear→set)
    // after condition-clear retired the arbiter fact (POD-890). Crash-replay of
    // the same transition still dedups via the live claim. Counts re-read AFTER
    // any new comments so a multi-child batch reports the latest numbers.
    // Same target filter as unblock: no resurrect, no shells.
    if (lastChildSeq == null) return
    // Full wire is intentional: the nudge reports derived child completion counts.
    const fresh = this.deps.issues.get(parentId)
    const total = fresh?.childCount ?? 0
    const remaining = Math.max(0, total - (fresh?.childDoneCount ?? 0))
    // Resolved once for the already-communicated check below — the child whose
    // transition drove this coalesced nudge.
    const lastChild = this.deps.issues.list(parent.repoPath).find((w) => w.seq === lastChildSeq)
    const targets = sessionsForIssue(
      parent.worktreePath,
      this.deps.listSessions(),
      parent.id,
    ).filter(
      (s) =>
        (s.status === 'live' || s.status === 'starting') &&
        s.agentKind !== 'shell' &&
        !causedBy.has(s.sessionId),
    )
    for (const s of targets) {
      // Already-communicated (§07b): the child may have mailed the parent
      // directly instead of relying on this nudge (targets are already
      // live/starting, so nothing here needs wake rights — see the
      // handleSessionParentNudge note on why that path is scoped out).
      if (
        lastChangeTs != null &&
        this.alreadyCommunicated(
          lastChild?.id,
          { sessionId: s.sessionId, issueId: parent.id },
          lastChangeTs,
        )
      ) {
        continue
      }
      // Durable delivery before claim [POD-925] — same ordering as handleUnblock.
      const factKey = `parentnudge:${group}:${parentId}:${lastChildSeq}`
      if (this.arbiter.isClaimed(factKey, s.sessionId)) continue
      this.deps.sendTextWhenReady(
        s.sessionId,
        sub.nudge(lastChildSeq, { remaining, total }),
        factKey,
      )
      this.arbiter.claim(factKey, s.sessionId, {
        source: 'steward.parent-nudge',
        issueId: parent.id,
      })
    }
  }

  /** Deterministic ack fallback (#237) [spec:SP-34d7 acks]: a settled session's
   *  unacked senders get one system notice each. The batch coalesces repeated
   *  phase flips in a poll; the LAST event's shape names the outcome. The seam
   *  itself queries delivered+unacked at call time, so an agent ack that landed
   *  first suppresses the notice (acked_by null-check), and a crash-replayed
   *  batch re-queries an empty set. */
  private handleAckFallback(sessionId: string, batch: StewardEvent[]): void {
    if (!this.deps.messaging) return
    const last = batch[batch.length - 1]!
    const p = last.payload as { phase?: string } | null
    const issueId = this.deps.listSessions().find((s) => s.sessionId === sessionId)?.issueId
    const factKey = `settle:${sessionId}`
    if (
      !this.arbiter.claim(factKey, sessionId, {
        source: 'steward.ack-fallback',
        issueId: issueId ?? undefined,
      })
    ) {
      return
    }
    this.deps.messaging.ackFallback(sessionId, p?.phase === 'errored' ? 'errored' : 'finished', {
      factKey,
      target: sessionId,
    })
  }

  /** P1: needs-human only leaves a breadcrumb in the log (briefs are P3). */
  private handleNeedsHuman(batch: StewardEvent[]): void {
    const last = batch[batch.length - 1]!
    this.deps.store.appendEvent({
      ts: this.now(),
      kind: 'steward.observed',
      subject: last.subject,
      repoPath: last.repoPath,
      payload: { of: last.id, kind: last.kind },
    })
  }
}
